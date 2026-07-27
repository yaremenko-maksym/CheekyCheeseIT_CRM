import { Global, Module } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { drizzle } from 'drizzle-orm/node-postgres'
import { and, eq, inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { MAKSYM_ID, KOSTYA_ID } from '@crm/shared'

import { DatabaseService } from '../database/database.service'
import { CompanyAccountService } from './company-account.service'
import { TransactionsService } from './transactions.service'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'
import { computeCompanyAccountBalanceFromLedger } from './company-account-balance'
import type { DepositVerification, EtherscanService } from './etherscan.service'
import { withDerivedMinorUnits, type ScriptedVerification } from './__test-helpers__/etherscan-fake'
import type { NbuCurrencyService } from './nbu-currency.service'
import {
  companyAccount,
  payoutRequests,
  pendingObligations,
  projects,
  transactions,
  users,
} from '../database/schema'
import * as schema from '../database/schema'

/**
 * fix/payout-credits-company-account (Variant A) — REAL-DB integration proving
 * the redundant 50/50 PAYOUT_ADMIN split is GONE from payout settlement.
 *
 * The company USDT account is already credited the full `payable` via the PAYOUT
 * row's fundingSource='COMPANY_ACCOUNT' marker
 * (computeCompanyAccountBalanceFromLedger: +Σ PAYOUT(PAID, COMPANY_ACCOUNT)).
 * The cascade ALSO used to insert two PAYOUT_ADMIN rows (50/50 onto each admin's
 * personal balance) — a SECOND distribution of the same money on top of the
 * company-account credit (the two «Доли партнёра» the owner flagged). Admin
 * income is now a deliberate manual flow (DIVIDEND_TO_ADMIN), so the auto split
 * is removed.
 *
 * Invariants proven (all against the REAL cascade + REAL balance derivation):
 *   AC1  senior on-chain payout PAID  → 0 PAYOUT_ADMIN; balance += payable ONCE.
 *   AC2  drop-project payout PAID     → 0 PAYOUT_ADMIN; PAYOUT_DROP slice intact;
 *                                       balance += payable ONCE.
 *   AC3  manual COMPANY_ACCOUNT       → 0 PAYOUT_ADMIN; balance credited ONCE.
 *   AC4  manual CASH / ADMIN_USDT     → 0 PAYOUT_ADMIN; balance UNCHANGED (the
 *                                       company account is not the recipient).
 *   AC5  display balance (getAccount) == gate balance
 *                                       (computeCompanyAccountBalanceFromLedger)
 *                                       — one SSOT, no drift.
 *
 * Etherscan is a controllable fake (per-hash scripted verification); NBU is a
 * fixed identity stub (USDT-only). The DB, the cascade, and the balance
 * derivation are REAL.
 *
 * Run against a scratch DB (NEVER the live crm_db):
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_qa \
 *     pnpm --filter @crm/api test -- payout-no-admin-split.integration
 */

const WALLET = '0xC0FFEE0000000000000000000000000000000def'
const THRESHOLD = 12

const SENIOR: SessionUser = {
  id: 'cb220000-0000-4000-bb00-000000000001',
  email: 'nosplit-senior@test.spec',
  displayName: 'NoSplit Senior',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}
const SENIOR2: SessionUser = {
  ...SENIOR,
  id: 'cb220000-0000-4000-bb00-000000000005',
  email: 'nosplit-senior2@test.spec',
  displayName: 'NoSplit Senior Two',
}
const DROP: SessionUser = {
  ...SENIOR,
  id: 'cb220000-0000-4000-bb00-000000000004',
  email: 'nosplit-drop@test.spec',
  displayName: 'NoSplit Drop',
  role: 'DROP',
}
// The cascade's partner split targeted MAKSYM_ID / KOSTYA_ID specifically — seed
// them as real ADMIN rows so that, on the OLD code, the `admin` lookup inside the
// (now-removed) split loop would have SUCCEEDED and produced PAYOUT_ADMIN rows.
// This makes the "0 PAYOUT_ADMIN" assertion a real regression guard, not a
// no-op that passes because the admins simply didn't exist.
const ADMIN_MAKSYM: SessionUser = {
  ...SENIOR,
  id: MAKSYM_ID,
  email: 'nosplit-maksym@test.spec',
  displayName: 'NoSplit Maksym',
  role: 'ADMIN',
  seniorSharePercent: 0,
}
const ADMIN_KOSTYA: SessionUser = {
  ...ADMIN_MAKSYM,
  id: KOSTYA_ID,
  email: 'nosplit-kostya@test.spec',
  displayName: 'NoSplit Kostya',
}

// Test-only users — fully owned by this suite, safe to delete/recreate.
const TEST_OWN_USERS = [SENIOR, SENIOR2, DROP]
const TEST_OWN_USER_IDS = TEST_OWN_USERS.map((u) => u.id)
// MAKSYM/KOSTYA are the SHARED seed admins (the cascade's hardcoded split
// targets) — they already exist in crm_qa and are referenced by other tables
// (contract_templates FK). NEVER delete them; only ensure they exist + are ADMIN.
const SEED_ADMINS = [ADMIN_MAKSYM, ADMIN_KOSTYA]
const ACCOUNT_ID = 'cb220000-0000-4000-cc00-000000000001'
const DROP_PROJECT_ID = 'cb220000-0000-4000-dd00-000000000001'

// ── Controllable fake Etherscan: per-hash scripted verification ──────────────
const verifyScript = new Map<string, ScriptedVerification>()
const fakeEtherscan: Pick<EtherscanService, 'verifyDeposit'> = {
  verifyDeposit: (txHash: string): Promise<DepositVerification> =>
    Promise.resolve(withDerivedMinorUnits(verifyScript.get(txHash))),
}

// Fixed-rate NBU stub (USDT incomes → identity conversion; never hits network).
const fakeNbu: Pick<NbuCurrencyService, 'getRates'> = {
  getRates: () =>
    Promise.resolve({ usdUah: '40.0000', usdtUah: '40.0000', eurUah: '44.0000', date: '20260620' }),
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
class NoSplitTestModule {}

describe('payout settlement — NO redundant 50/50 PAYOUT_ADMIN split (real DB)', () => {
  let svc: TransactionsService
  let companySvc: CompanyAccountService
  let dbSvc: DatabaseService

  async function clearAll() {
    // Only rows attributable to THIS suite — scoped strictly to our test-own
    // seniors/drop. CRUCIAL: never key cleanup on the seed admin ids, which are
    // shared fixtures with unrelated rows in crm_qa. The cascade stamps every
    // row it inserts (incl. any PAYOUT_ADMIN split row received by a seed admin)
    // with senderId = createdBy = the test owner (currentUser = senior/drop), so
    // the test-own createdBy/senderId filters fully cover the split rows too.
    // task-drop-payout-company-account: the drop cascade now creates a
    // pending_obligations row (creditor = senior) referencing a
    // SENIOR_PENDING_PAYOUT tx — delete obligations FIRST so the transactions
    // delete below does not trip the FK (source_transaction_id → transactions.id).
    await dbSvc.db
      .delete(pendingObligations)
      .where(inArray(pendingObligations.creditorUserId, TEST_OWN_USER_IDS))
    await dbSvc.db.delete(transactions).where(inArray(transactions.createdBy, TEST_OWN_USER_IDS))
    await dbSvc.db.delete(transactions).where(inArray(transactions.senderId, TEST_OWN_USER_IDS))
    await dbSvc.db.delete(transactions).where(inArray(transactions.receiverId, TEST_OWN_USER_IDS))
    await dbSvc.db.delete(payoutRequests).where(inArray(payoutRequests.seniorId, TEST_OWN_USER_IDS))
    await dbSvc.db.delete(projects).where(eq(projects.id, DROP_PROJECT_ID))
  }

  /** Company-account DISPLAY balance (GET /company-account). */
  async function displayBalance(): Promise<number> {
    return (await companySvc.getAccount(ADMIN_MAKSYM)).balance
  }

  /** Company-account GATE balance (the ledger SSOT used by debit gates). */
  async function gateBalance(): Promise<number> {
    return computeCompanyAccountBalanceFromLedger(dbSvc.db)
  }

  /** Count of PAYOUT_ADMIN rows for a given payout request. */
  async function payoutAdminCount(requestId: string): Promise<number> {
    const rows = await dbSvc.db
      .select({ id: transactions.id })
      .from(transactions)
      .where(
        and(eq(transactions.payoutRequestId, requestId), eq(transactions.type, 'PAYOUT_ADMIN')),
      )
    return rows.length
  }

  /** PAYOUT_DROP rows (amount strings) for a given payout request. */
  async function payoutDropRows(requestId: string): Promise<string[]> {
    const rows = await dbSvc.db
      .select({ amount: transactions.amount })
      .from(transactions)
      .where(and(eq(transactions.payoutRequestId, requestId), eq(transactions.type, 'PAYOUT_DROP')))
    return rows.map((r) => r.amount)
  }

  // Seed a VALIDATED SENIOR_INCOME (USDT) owned by the senior, then create a
  // payout_request for it (senior-project — project.dropId is null).
  async function seedSeniorPayout(
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

  // Seed a drop-project + a VALIDATED DROP_INCOME owned by the DROP + its
  // placeholder PAYOUT (PENDING_PAYMENT). The DROP user owns the payout request.
  async function seedDropPayout(
    income: string,
    payable: string,
  ): Promise<{ requestId: string; payable: number }> {
    await dbSvc.db
      .insert(projects)
      .values({
        id: DROP_PROJECT_ID,
        name: 'NoSplit Drop Project',
        companyName: 'NoSplit DropCorp',
        domain: 'fintech',
        startDate: new Date('2025-01-01'),
        seniorId: SENIOR.id,
        dropId: DROP.id,
        currency: 'USDT',
        rate: 1000,
      })
      .onConflictDoNothing()

    const [pr] = await dbSvc.db
      .insert(payoutRequests)
      .values({
        seniorId: DROP.id,
        incomeAmount: income,
        payableAmount: payable,
        contractAddress: '0x' + 'e'.repeat(40),
        status: 'PENDING',
      })
      .returning()

    await dbSvc.db.insert(transactions).values([
      {
        type: 'DROP_INCOME',
        status: 'VALIDATED',
        amount: income,
        currency: 'USDT',
        senderId: null,
        senderLabel: 'NoSplit DropCorp',
        receiverId: DROP.id,
        recipientId: DROP.id,
        projectId: DROP_PROJECT_ID,
        payoutRequestId: pr!.id,
        createdBy: DROP.id,
      },
      {
        type: 'PAYOUT',
        status: 'PENDING_PAYMENT',
        amount: payable,
        currency: 'USDT',
        senderId: DROP.id,
        receiverLabel: 'CheekyCheeseIT',
        projectId: DROP_PROJECT_ID,
        payoutRequestId: pr!.id,
        createdBy: DROP.id,
      },
    ])
    return { requestId: pr!.id, payable: parseFloat(payable) }
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
        console.warn('[payout-no-admin-split] SKIPPED — payout_requests table not found')
        dbAvailable = false
        return
      }
    } catch {
      console.warn('[payout-no-admin-split] SKIPPED — no DB reachable at DATABASE_URL')
      dbAvailable = false
      return
    }

    const moduleRef = await Test.createTestingModule({ imports: [NoSplitTestModule] }).compile()
    await moduleRef.init()
    svc = moduleRef.get(TransactionsService)
    companySvc = moduleRef.get(CompanyAccountService)
    dbSvc = moduleRef.get(DatabaseService)

    const db = dbSvc.db
    await clearAll()
    // Recreate ONLY the test-own users (delete is safe — they belong to us and
    // are never referenced by shared tables). Seed admins (MAKSYM/KOSTYA) are
    // pre-existing shared fixtures with FK references elsewhere — only ensure
    // they exist via onConflictDoNothing; never delete them.
    await db.delete(users).where(inArray(users.id, TEST_OWN_USER_IDS))
    await db
      .insert(users)
      .values(
        [...TEST_OWN_USERS, ...SEED_ADMINS].map((u) => ({
          id: u.id,
          email: u.email,
          displayName: u.displayName,
          role: u.role,
          ...(u.role === 'DROP' ? { dropSharePercent: 5 } : {}),
          googleId: `test-google-${u.id}`,
        })),
      )
      .onConflictDoNothing()

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
        updatedBy: ADMIN_MAKSYM.id,
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
      // Remove ONLY the test-own users; seed admins (MAKSYM/KOSTYA) stay.
      await dbSvc.db.delete(users).where(inArray(users.id, TEST_OWN_USER_IDS))
    } catch {
      // non-fatal
    }
    await _pool?.end()
  }, 15_000)

  // ── AC1: senior on-chain payout → 0 PAYOUT_ADMIN, balance += payable once ────
  it('AC1 senior on-chain payout PAID → 0 PAYOUT_ADMIN; company balance += payable (once)', async () => {
    if (!dbAvailable) return
    const before = await displayBalance()
    const { requestId, payable } = await seedSeniorPayout(SENIOR, '1000') // payable 740
    const HASH = '0x' + '1'.repeat(64)
    verifyScript.set(HASH, {
      found: true,
      toMatches: true,
      confirmed: true,
      confirmations: THRESHOLD,
      amountUsdt: payable,
    })

    const result = await svc.payPayoutRequest(requestId, HASH, SENIOR)
    expect(result.status).toBe('PAID')

    // CORE: no auto 50/50 partner split rows.
    expect(await payoutAdminCount(requestId)).toBe(0)
    // Company account credited EXACTLY the payable, EXACTLY once.
    expect(await displayBalance()).toBeCloseTo(before + payable, 6)
  })

  // ── AC2: drop-project payout → 0 PAYOUT_ADMIN, PAYOUT_DROP intact, +payable ──
  it('AC2 drop-project payout PAID → 0 PAYOUT_ADMIN; PAYOUT_DROP drop-slice intact; balance += payable (once)', async () => {
    if (!dbAvailable) return
    const before = await displayBalance()
    // income 1000, dropShare 5% → 50 to drop, payable 950 transferred to company.
    const { requestId, payable } = await seedDropPayout('1000', '950')
    const HASH = '0x' + '2'.repeat(64)
    verifyScript.set(HASH, {
      found: true,
      toMatches: true,
      confirmed: true,
      confirmations: THRESHOLD,
      amountUsdt: payable,
    })

    const result = await svc.payPayoutRequest(requestId, HASH, DROP)
    expect(result.status).toBe('PAID')

    // CORE: no auto partner split (the drop-branch partnerShares loop is gone).
    expect(await payoutAdminCount(requestId)).toBe(0)

    // The DROP's distribution slice is untouched: exactly one PAYOUT_DROP row of
    // (income * dropSharePercent/100) = 1000 * 5% = 50.
    const dropRows = await payoutDropRows(requestId)
    expect(dropRows).toHaveLength(1)
    expect(parseFloat(dropRows[0]!)).toBeCloseTo(50, 6)

    // Company account credited the recorded payable (the PAYOUT row), once.
    expect(await displayBalance()).toBeCloseTo(before + payable, 6)
  })

  // ── AC3: manual COMPANY_ACCOUNT → 0 PAYOUT_ADMIN, credited once ──────────────
  it('AC3 manual COMPANY_ACCOUNT confirm → 0 PAYOUT_ADMIN; balance credited once', async () => {
    if (!dbAvailable) return
    const before = await displayBalance()
    const { requestId, payable } = await seedSeniorPayout(SENIOR, '1000')

    const result = await svc.manualConfirmPayout(requestId, 'COMPANY_ACCOUNT', ADMIN_MAKSYM)
    expect(result.status).toBe('PAID')

    expect(await payoutAdminCount(requestId)).toBe(0)
    expect(await displayBalance()).toBeCloseTo(before + payable, 6)
  })

  // ── AC4: manual CASH / ADMIN_USDT → 0 PAYOUT_ADMIN, balance UNCHANGED ────────
  // The chosen admin is credited (when applicable) through the SEPARATE
  // confirmPayout → PAYOUT_CONFIRMED flow, not through this cascade. From the UI
  // these two methods are unreachable on this path (ConfirmPayoutDialog routes
  // CASH/CRYPTO to confirmPayout); manualConfirmPayout is only ever called with
  // COMPANY_ACCOUNT. Here we exercise the API-level branches directly to prove
  // removing the split does NOT silently lose money on the company account.
  it('AC4 manual CASH confirm → 0 PAYOUT_ADMIN; company balance UNCHANGED (off the company account)', async () => {
    if (!dbAvailable) return
    const before = await displayBalance()
    const { requestId } = await seedSeniorPayout(SENIOR, '1000')

    const result = await svc.manualConfirmPayout(requestId, 'CASH', ADMIN_MAKSYM)
    expect(result.status).toBe('PAID')

    expect(await payoutAdminCount(requestId)).toBe(0)
    expect(await displayBalance()).toBe(before)
  })

  it('AC4 manual ADMIN_USDT confirm → 0 PAYOUT_ADMIN; company balance UNCHANGED', async () => {
    if (!dbAvailable) return
    const before = await displayBalance()
    const { requestId } = await seedSeniorPayout(SENIOR, '1000')

    const result = await svc.manualConfirmPayout(requestId, 'ADMIN_USDT', ADMIN_MAKSYM)
    expect(result.status).toBe('PAID')

    expect(await payoutAdminCount(requestId)).toBe(0)
    expect(await displayBalance()).toBe(before)
  })

  // ── AC5: display balance == gate balance (single SSOT, no drift) ─────────────
  it('AC5 display balance (getAccount) == gate balance (ledger SSOT) after a payout', async () => {
    if (!dbAvailable) return
    const { requestId, payable } = await seedSeniorPayout(SENIOR2, '500')
    const HASH = '0x' + '5'.repeat(64)
    verifyScript.set(HASH, {
      found: true,
      toMatches: true,
      confirmed: true,
      confirmations: THRESHOLD,
      amountUsdt: payable,
    })
    await svc.payPayoutRequest(requestId, HASH, SENIOR2)

    const display = await displayBalance()
    const gate = await gateBalance()
    expect(display).toBeCloseTo(gate, 6)
    // And the credit is the payable — no split inflating either side.
    expect(await payoutAdminCount(requestId)).toBe(0)
  })
})
