import { Global, Module } from '@nestjs/common'
import { BadRequestException, ForbiddenException } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { drizzle } from 'drizzle-orm/node-postgres'
import { and, eq, inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'

import { DatabaseService } from '../database/database.service'
import { CompanyAccountService } from './company-account.service'
import { TransactionsService } from './transactions.service'
import type { DepositVerification, EtherscanService } from './etherscan.service'
import type { NbuCurrencyService } from './nbu-currency.service'
import { companyAccount, payoutRequests, transactions, users } from '../database/schema'
import * as schema from '../database/schema'

/**
 * task-payout-company-wallet (Phase 8 v2) — backend integration against REAL
 * PostgreSQL (crm_qa, NEVER crm_db) with a controllable EtherscanService.
 *
 * Proves the money-critical invariants:
 *   AC3  on-chain confirm: valid tx (to=company wallet, confirmed, amount≈payable)
 *        → payout PAID + company balance += payable. wrong-recipient /
 *        not-confirmed / amount-mismatch → NOT PAID, balance unchanged.
 *   AC5  manual-confirm RBAC: SENIOR/DROP → ForbiddenException (403); ADMIN /
 *        ACCOUNTANT → PAID. COMPANY_ACCOUNT credits the balance; ADMIN_USDT /
 *        CASH do NOT.
 *   AC6  idempotency: a second confirm of an already-PAID payout throws and the
 *        balance is not doubled; a txHash reused across payouts is rejected.
 *
 * The Etherscan layer is a controllable fake (per-hash scripted verification) so
 * valid / mismatch / pending / amount-off branches are deterministic without the
 * network. The NBU layer is a fixed-rate stub (USDT batches only here, so the
 * conversion is identity). The DB, the balance derivation, and the cascade are
 * REAL — this is a real-controller test (services wired via @Inject /
 * useFactory), NOT a sentinel mirror.
 *
 * Run against a scratch DB (NEVER the live crm_db):
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_qa \
 *     pnpm --filter @crm/api test -- payout-company-wallet.integration
 */

const WALLET = '0xC0FFEE0000000000000000000000000000000abc'
const THRESHOLD = 12

const SENIOR: SessionUser = {
  id: 'ca110000-0000-4000-aa00-000000000001',
  email: 'pay-senior@test.spec',
  displayName: 'Pay Senior',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}
const SENIOR2: SessionUser = {
  ...SENIOR,
  id: 'ca110000-0000-4000-aa00-000000000005',
  email: 'pay-senior2@test.spec',
  displayName: 'Pay Senior Two',
}
const ADMIN: SessionUser = {
  ...SENIOR,
  id: 'ca110000-0000-4000-aa00-000000000002',
  email: 'pay-admin@test.spec',
  displayName: 'Pay Admin',
  role: 'ADMIN',
  seniorSharePercent: 0,
}
const ACCOUNTANT: SessionUser = {
  ...SENIOR,
  id: 'ca110000-0000-4000-aa00-000000000003',
  email: 'pay-acc@test.spec',
  displayName: 'Pay Accountant',
  role: 'ACCOUNTANT',
}
const DROP: SessionUser = {
  ...SENIOR,
  id: 'ca110000-0000-4000-aa00-000000000004',
  email: 'pay-drop@test.spec',
  displayName: 'Pay Drop',
  role: 'DROP',
}

const ALL = [SENIOR, SENIOR2, ADMIN, ACCOUNTANT, DROP]
const TEST_USER_IDS = ALL.map((u) => u.id)
const ACCOUNT_ID = 'ca110000-0000-4000-cc00-000000000001'

// ── Controllable fake Etherscan: per-hash scripted verification ──────────────
const verifyScript = new Map<string, DepositVerification>()
const fakeEtherscan: Pick<EtherscanService, 'verifyDeposit'> = {
  verifyDeposit: (txHash: string): Promise<DepositVerification> =>
    Promise.resolve(
      verifyScript.get(txHash) ?? {
        found: false,
        toMatches: false,
        confirmed: false,
        confirmations: 0,
        amountUsdt: null,
      },
    ),
}

// Fixed-rate NBU stub (USDT incomes → identity conversion; never hits network).
const fakeNbu: Pick<NbuCurrencyService, 'getRates'> = {
  getRates: () =>
    Promise.resolve({ usdUah: '40.0000', usdtUah: '40.0000', eurUah: '44.0000', date: '20260620' }),
}

// Best-effort invoice/documents collaborators — irrelevant to the money logic.
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
        new TransactionsService(
          db,
          stubInvoices,
          stubDocuments,
          fakeNbu as NbuCurrencyService,
          fakeEtherscan as EtherscanService,
        ),
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
class PayoutTestModule {}

describe('payout → company wallet — on-chain confirm + manual-confirm RBAC (real DB)', () => {
  let svc: TransactionsService
  let companySvc: CompanyAccountService
  let dbSvc: DatabaseService

  // Clean every payout-related row this suite may touch.
  async function clearAll() {
    await dbSvc.db.delete(transactions).where(inArray(transactions.createdBy, TEST_USER_IDS))
    await dbSvc.db.delete(transactions).where(inArray(transactions.senderId, TEST_USER_IDS))
    await dbSvc.db.delete(payoutRequests).where(inArray(payoutRequests.seniorId, TEST_USER_IDS))
  }

  async function balance(): Promise<number> {
    return (await companySvc.getAccount(ADMIN)).balance
  }

  // Seed a VALIDATED SENIOR_INCOME (USDT) owned by the senior, then create a
  // payout_request for it. Returns { requestId, payable }.
  async function seedPayout(
    owner: SessionUser,
    amount: string,
    sharePercent = 26,
  ): Promise<{ requestId: string; payable: number }> {
    const [income] = await dbSvc.db
      .insert(transactions)
      .values({
        type: 'SENIOR_INCOME',
        status: 'VALIDATED',
        amount,
        currency: 'USDT',
        receiverId: owner.id,
        seniorSharePercent: sharePercent,
        createdBy: owner.id,
      })
      .returning()
    const pr = await svc.createPayoutRequest([income!.id], owner)
    return { requestId: pr.id, payable: parseFloat(pr.payableAmount) }
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
        console.warn('[payout-company-wallet] SKIPPED — payout_requests table not found')
        dbAvailable = false
        return
      }
    } catch {
      console.warn('[payout-company-wallet] SKIPPED — no DB reachable at DATABASE_URL')
      dbAvailable = false
      return
    }

    const moduleRef = await Test.createTestingModule({ imports: [PayoutTestModule] }).compile()
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

  // ── AC3: valid on-chain confirm → PAID + balance += payable ─────────────────
  it('on-chain confirm: valid tx (to=wallet, confirmed, amount≈payable) → PAID, balance += payable', async () => {
    if (!dbAvailable) return
    const before = await balance()
    const { requestId, payable } = await seedPayout(SENIOR, '1000') // payable = 740 USDT
    const HASH = '0x' + '1'.repeat(64)
    verifyScript.set(HASH, {
      found: true,
      toMatches: true,
      confirmed: true,
      confirmations: THRESHOLD,
      amountUsdt: payable, // exact match
    })

    const result = await svc.payPayoutRequest(requestId, HASH, SENIOR)
    expect(result.status).toBe('PAID')
    expect(await balance()).toBeCloseTo(before + payable, 6)
  })

  // ── AC3: wrong recipient → NOT PAID, balance unchanged ──────────────────────
  it('SECURITY: tx to a DIFFERENT recipient → rejected, payout stays PENDING, no credit', async () => {
    if (!dbAvailable) return
    const before = await balance()
    const { requestId, payable } = await seedPayout(SENIOR, '1000')
    const HASH = '0x' + '2'.repeat(64)
    verifyScript.set(HASH, {
      found: true,
      toMatches: false, // recipient mismatch
      confirmed: false,
      confirmations: THRESHOLD,
      amountUsdt: payable,
    })

    await expect(svc.payPayoutRequest(requestId, HASH, SENIOR)).rejects.toThrow()
    const pr = await dbSvc.db.query.payoutRequests.findFirst({
      where: eq(payoutRequests.id, requestId),
    })
    expect(pr?.status).toBe('PENDING')
    expect(await balance()).toBe(before)
  })

  // ── AC3: not confirmed (below threshold) → NOT PAID ─────────────────────────
  it('SECURITY: matching recipient but NOT confirmed → rejected, no credit', async () => {
    if (!dbAvailable) return
    const before = await balance()
    const { requestId, payable } = await seedPayout(SENIOR, '1000')
    const HASH = '0x' + '3'.repeat(64)
    verifyScript.set(HASH, {
      found: true,
      toMatches: true,
      confirmed: false, // below threshold
      confirmations: 3,
      amountUsdt: payable,
    })

    await expect(svc.payPayoutRequest(requestId, HASH, SENIOR)).rejects.toThrow()
    expect(await balance()).toBe(before)
  })

  // ── AC3: amount mismatch (outside tolerance) → NOT PAID ─────────────────────
  it('SECURITY: confirmed but amount far below payable → rejected, no credit', async () => {
    if (!dbAvailable) return
    const before = await balance()
    const { requestId, payable } = await seedPayout(SENIOR, '1000') // payable 740
    const HASH = '0x' + '4'.repeat(64)
    verifyScript.set(HASH, {
      found: true,
      toMatches: true,
      confirmed: true,
      confirmations: THRESHOLD,
      amountUsdt: payable * 0.5, // 50% short — way outside the 1% band
    })

    await expect(svc.payPayoutRequest(requestId, HASH, SENIOR)).rejects.toThrow()
    expect(await balance()).toBe(before)
  })

  // ── AC3: amount within 1% tolerance → PAID ──────────────────────────────────
  it('on-chain confirm: amount within 1% tolerance → PAID, balance += payable', async () => {
    if (!dbAvailable) return
    const before = await balance()
    const { requestId, payable } = await seedPayout(SENIOR, '1000') // 740
    const HASH = '0x' + '5'.repeat(64)
    verifyScript.set(HASH, {
      found: true,
      toMatches: true,
      confirmed: true,
      confirmations: THRESHOLD,
      amountUsdt: payable * 1.005, // +0.5% — inside the 1% band
    })

    const result = await svc.payPayoutRequest(requestId, HASH, SENIOR)
    expect(result.status).toBe('PAID')
    // Balance credits the RECORDED payable (the PAYOUT row amount), not the
    // slightly-different on-chain figure — no double count, deterministic.
    expect(await balance()).toBeCloseTo(before + payable, 6)
  })

  // ── AC6: idempotency — re-confirm of a PAID payout throws, no double credit ──
  it('IDEMPOTENCY: second pay of an already-PAID payout throws, balance not doubled', async () => {
    if (!dbAvailable) return
    const before = await balance()
    const { requestId, payable } = await seedPayout(SENIOR, '1000')
    const HASH = '0x' + '6'.repeat(64)
    verifyScript.set(HASH, {
      found: true,
      toMatches: true,
      confirmed: true,
      confirmations: THRESHOLD,
      amountUsdt: payable,
    })

    await svc.payPayoutRequest(requestId, HASH, SENIOR)
    const afterFirst = await balance()
    expect(afterFirst).toBeCloseTo(before + payable, 6)

    // Second attempt on the same (now PAID) request → rejected.
    await expect(svc.payPayoutRequest(requestId, HASH, SENIOR)).rejects.toThrow()
    expect(await balance()).toBeCloseTo(afterFirst, 6)
  })

  // ── AC6: txHash reuse across payouts is rejected ────────────────────────────
  it('IDEMPOTENCY: reusing a txHash on a SECOND payout is rejected, no double credit', async () => {
    if (!dbAvailable) return
    const before = await balance()
    const first = await seedPayout(SENIOR, '1000')
    const second = await seedPayout(SENIOR2, '1000')
    const HASH = '0x' + '7'.repeat(64)
    verifyScript.set(HASH, {
      found: true,
      toMatches: true,
      confirmed: true,
      confirmations: THRESHOLD,
      amountUsdt: first.payable,
    })

    await svc.payPayoutRequest(first.requestId, HASH, SENIOR)
    const afterFirst = await balance()
    expect(afterFirst).toBeCloseTo(before + first.payable, 6)

    // Same hash, different payout → rejected (the on-chain transfer happened once).
    await expect(svc.payPayoutRequest(second.requestId, HASH, SENIOR2)).rejects.toThrow()
    expect(await balance()).toBeCloseTo(afterFirst, 6)
  })

  // ── AC5: manual-confirm RBAC — SENIOR / DROP forbidden ──────────────────────
  it('RBAC: SENIOR cannot manual-confirm (403)', async () => {
    if (!dbAvailable) return
    const { requestId } = await seedPayout(SENIOR, '1000')
    await expect(
      svc.manualConfirmPayout(requestId, 'COMPANY_ACCOUNT', SENIOR),
    ).rejects.toBeInstanceOf(ForbiddenException)
  })

  it('RBAC: DROP cannot manual-confirm (403)', async () => {
    if (!dbAvailable) return
    const { requestId } = await seedPayout(SENIOR, '1000')
    await expect(svc.manualConfirmPayout(requestId, 'CASH', DROP)).rejects.toBeInstanceOf(
      ForbiddenException,
    )
  })

  // ── AC5: manual-confirm COMPANY_ACCOUNT → PAID + credits balance ────────────
  it('manual-confirm COMPANY_ACCOUNT (ADMIN) → PAID, balance += payable', async () => {
    if (!dbAvailable) return
    const before = await balance()
    const { requestId, payable } = await seedPayout(SENIOR, '1000')

    const result = await svc.manualConfirmPayout(requestId, 'COMPANY_ACCOUNT', ADMIN)
    expect(result.status).toBe('PAID')
    expect(await balance()).toBeCloseTo(before + payable, 6)
  })

  // ── AC5: manual-confirm ADMIN_USDT → PAID but NO credit ─────────────────────
  it('manual-confirm ADMIN_USDT (ACCOUNTANT) → PAID, balance UNCHANGED (off the company account)', async () => {
    if (!dbAvailable) return
    const before = await balance()
    const { requestId } = await seedPayout(SENIOR, '1000')

    const result = await svc.manualConfirmPayout(requestId, 'ADMIN_USDT', ACCOUNTANT)
    expect(result.status).toBe('PAID')
    expect(await balance()).toBe(before)
  })

  // ── AC5: manual-confirm CASH → PAID but NO credit ───────────────────────────
  it('manual-confirm CASH (ADMIN) → PAID, balance UNCHANGED', async () => {
    if (!dbAvailable) return
    const before = await balance()
    const { requestId } = await seedPayout(SENIOR, '1000')

    const result = await svc.manualConfirmPayout(requestId, 'CASH', ADMIN)
    expect(result.status).toBe('PAID')
    expect(await balance()).toBe(before)
  })

  // ── AC6: manual-confirm idempotency — second confirm throws, no double credit ─
  it('IDEMPOTENCY: re-manual-confirm of a PAID payout throws, balance not doubled', async () => {
    if (!dbAvailable) return
    const before = await balance()
    const { requestId, payable } = await seedPayout(SENIOR, '1000')

    await svc.manualConfirmPayout(requestId, 'COMPANY_ACCOUNT', ADMIN)
    const afterFirst = await balance()
    expect(afterFirst).toBeCloseTo(before + payable, 6)

    await expect(svc.manualConfirmPayout(requestId, 'COMPANY_ACCOUNT', ADMIN)).rejects.toThrow()
    expect(await balance()).toBeCloseTo(afterFirst, 6)
  })

  // ── H1: txHash-reuse guard on manual-confirm COMPANY_ACCOUNT ─────────────────
  // The exploit closed: an ADMIN/ACCOUNTANT could manual-confirm a SECOND payout
  // with method=COMPANY_ACCOUNT + a REAL on-chain hash already consumed by a PAID
  // payout, crediting the company balance TWICE for one on-chain transfer (no DB
  // unique index on payout_requests.txHash backstops this). Now → BadRequest, no
  // double credit. Mirrors the on-chain reuse guard in payPayoutRequest.
  it('H1 SECURITY: reusing a real txHash on a SECOND manual COMPANY_ACCOUNT confirm → rejected, no double credit', async () => {
    if (!dbAvailable) return
    const REAL_HASH = '0x' + 'a'.repeat(64)
    const before = await balance()

    const first = await seedPayout(SENIOR, '1000')
    const second = await seedPayout(SENIOR2, '1000')

    // First manual-confirm with the real hash → PAID, balance += payable.
    const r1 = await svc.manualConfirmPayout(first.requestId, 'COMPANY_ACCOUNT', ADMIN, {
      txHash: REAL_HASH,
    })
    expect(r1.status).toBe('PAID')
    const afterFirst = await balance()
    expect(afterFirst).toBeCloseTo(before + first.payable, 6)

    // SAME real hash on a DIFFERENT payout → rejected (the transfer happened once).
    await expect(
      svc.manualConfirmPayout(second.requestId, 'COMPANY_ACCOUNT', ADMIN, { txHash: REAL_HASH }),
    ).rejects.toBeInstanceOf(BadRequestException)

    // Balance unchanged; the second payout stays PENDING.
    expect(await balance()).toBeCloseTo(afterFirst, 6)
    const pr2 = await dbSvc.db.query.payoutRequests.findFirst({
      where: eq(payoutRequests.id, second.requestId),
    })
    expect(pr2?.status).toBe('PENDING')
  })

  // ── H1: synthetic-marker manual confirms are NOT blocked by the reuse guard ──
  // Two manual COMPANY_ACCOUNT confirms WITHOUT a real hash each get a unique
  // random 0xMANUAL marker, so the guard must not false-positive: both succeed
  // and both credit the balance (they are two distinct off-chain settlements).
  it('H1: two manual COMPANY_ACCOUNT confirms without a real hash both succeed (unique markers)', async () => {
    if (!dbAvailable) return
    const before = await balance()
    const first = await seedPayout(SENIOR, '1000')
    const second = await seedPayout(SENIOR2, '1000')

    await svc.manualConfirmPayout(first.requestId, 'COMPANY_ACCOUNT', ADMIN)
    await svc.manualConfirmPayout(second.requestId, 'COMPANY_ACCOUNT', ADMIN)

    expect(await balance()).toBeCloseTo(before + first.payable + second.payable, 6)
  })

  // ── M3: on-chain and manual confirm are MUTUALLY EXCLUSIVE (PENDING gate) ─────
  it('M3 cross-path: on-chain PAID payout cannot then be manual-confirmed (throws, no double credit)', async () => {
    if (!dbAvailable) return
    const before = await balance()
    const { requestId, payable } = await seedPayout(SENIOR, '1000')
    const HASH = '0x' + 'b'.repeat(64)
    verifyScript.set(HASH, {
      found: true,
      toMatches: true,
      confirmed: true,
      confirmations: THRESHOLD,
      amountUsdt: payable,
    })

    // On-chain happy path → PAID.
    await svc.payPayoutRequest(requestId, HASH, SENIOR)
    const afterOnChain = await balance()
    expect(afterOnChain).toBeCloseTo(before + payable, 6)

    // Manual-confirm of the now-PAID payout → rejected (status !== PENDING gate).
    await expect(svc.manualConfirmPayout(requestId, 'COMPANY_ACCOUNT', ADMIN)).rejects.toThrow()
    expect(await balance()).toBeCloseTo(afterOnChain, 6)
  })

  it('M3 cross-path: manual-PAID payout cannot then be paid on-chain (throws, no double credit)', async () => {
    if (!dbAvailable) return
    const before = await balance()
    const { requestId, payable } = await seedPayout(SENIOR, '1000')

    // Manual COMPANY_ACCOUNT confirm → PAID.
    await svc.manualConfirmPayout(requestId, 'COMPANY_ACCOUNT', ADMIN)
    const afterManual = await balance()
    expect(afterManual).toBeCloseTo(before + payable, 6)

    // payPayoutRequest on the now-PAID payout → rejected (status !== PENDING gate),
    // even with an otherwise-valid on-chain verification scripted.
    const HASH = '0x' + 'c'.repeat(64)
    verifyScript.set(HASH, {
      found: true,
      toMatches: true,
      confirmed: true,
      confirmations: THRESHOLD,
      amountUsdt: payable,
    })
    await expect(svc.payPayoutRequest(requestId, HASH, SENIOR)).rejects.toThrow()
    expect(await balance()).toBeCloseTo(afterManual, 6)
  })

  // ── AC2 (integration): mixed-currency batch → single USDT payout, no BadRequest ─
  it('createPayoutRequest: mixed-currency batch is accepted and produces one USDT payout', async () => {
    if (!dbAvailable) return
    const [usdtIncome] = await dbSvc.db
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
    const [usdIncome] = await dbSvc.db
      .insert(transactions)
      .values({
        type: 'SENIOR_INCOME',
        status: 'VALIDATED',
        amount: '500',
        currency: 'USD',
        receiverId: SENIOR.id,
        seniorSharePercent: 26,
        createdBy: SENIOR.id,
      })
      .returning()

    // Does NOT throw (the old mixed-currency guard is gone).
    const pr = await svc.createPayoutRequest([usdtIncome!.id, usdIncome!.id], SENIOR)

    // recipient = company wallet; payable = 740 USDT + 370 USD(=370 USDT) = 1110.
    expect(pr.contractAddress).toBe(WALLET)
    expect(parseFloat(pr.payableAmount)).toBeCloseTo(1110, 4)

    // The placeholder PAYOUT row is USDT.
    const payoutRow = await dbSvc.db.query.transactions.findFirst({
      where: and(eq(transactions.payoutRequestId, pr.id), eq(transactions.type, 'PAYOUT')),
    })
    expect(payoutRow?.currency).toBe('USDT')
    expect(parseFloat(payoutRow!.amount)).toBeCloseTo(1110, 4)
  })

  // ── createPayoutRequest: unset wallet → BadRequest ──────────────────────────
  it('createPayoutRequest throws BadRequest when the company wallet is not configured', async () => {
    if (!dbAvailable) return
    // Temporarily clear the wallet, then restore it.
    const row = await dbSvc.db.query.companyAccount.findFirst()
    await dbSvc.db
      .update(companyAccount)
      .set({ walletAddress: null })
      .where(eq(companyAccount.id, row!.id))
    try {
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
      await expect(svc.createPayoutRequest([income!.id], SENIOR)).rejects.toThrow()
    } finally {
      await dbSvc.db
        .update(companyAccount)
        .set({ walletAddress: WALLET })
        .where(eq(companyAccount.id, row!.id))
    }
  })
})
