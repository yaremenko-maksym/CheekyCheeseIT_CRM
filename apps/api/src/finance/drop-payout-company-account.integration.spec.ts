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
import { PendingSettlementService } from './pending-settlement.service'
import { TransactionsService } from './transactions.service'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'
import { computeCompanyAccountBalanceFromLedger } from './company-account-balance'
import type { DepositVerification, EtherscanService } from './etherscan.service'
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
 * task-drop-payout-company-account — REAL-DB integration proving the new DROP
 * settlement model (full senior/drop parity, money on the company account):
 *
 *   A DROP settles a validated DROP_INCOME via the SAME flow as a SENIOR —
 *   createPayoutRequest (bundle own VALIDATED DROP_INCOME) → payPayoutRequest
 *   (on-chain confirm to the COMPANY wallet). The cascade then books:
 *     - PAYOUT row PAID, fundingSource=COMPANY_ACCOUNT → company += payable ONCE.
 *     - PAYOUT_DROP = income * dropShare% (the drop's slice).
 *     - SENIOR_PENDING_PAYOUT (PENDING_PAYMENT, debtor=COMPANY) + a
 *       pending_obligation (creditor=senior, COMPANY) for income * seniorShare%.
 *     - ZERO PAYOUT_ADMIN (the legacy 50/50 split is gone).
 *
 *   settleByCompany (ADMIN/ACCOUNTANT) then closes the obligation → SENIOR_INCOME
 *   += seniorShare, company −= seniorShare. Net company = income*(1−d%−s%).
 *
 * Invariants proven (against the REAL cascade + REAL balance derivation):
 *   INV1  drop payout PAID → company += payable (once); PAYOUT_DROP = I*d%;
 *         SENIOR_PENDING_PAYOUT + obligation = I*s%; 0 PAYOUT_ADMIN.
 *   INV2  settleByCompany → senior SENIOR_INCOME += I*s%; company −= I*s%;
 *         net company = I*(1−d%−s%).
 *   INV3  senior payout (senior-project) unchanged → 0 PAYOUT_DROP / pending,
 *         company += payable once.
 *   INV4  display balance (getAccount) == gate balance (ledger SSOT) — no drift,
 *         no double-counting at any step.
 *   RBAC  DROP cannot bundle another's DROP_INCOME (createPayoutRequest → 400);
 *         settleByCompany only ADMIN/ACCOUNTANT (DROP/SENIOR → 403).
 *
 * Etherscan is a controllable fake (per-hash scripted verification); NBU is a
 * fixed identity stub (USDT-only). The DB, the cascade, the obligation, the
 * settlement, and the balance derivation are ALL real.
 *
 * Run against a scratch DB (NEVER the live crm_db):
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_qa \
 *     pnpm --filter @crm/api test -- drop-payout-company-account.integration
 */

const WALLET = '0xC0FFEE0000000000000000000000000000000abc'
const THRESHOLD = 12

const SENIOR: SessionUser = {
  id: 'cb330000-0000-4000-bb00-000000000001',
  email: 'dpca-senior@test.spec',
  displayName: 'DPCA Senior',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}
const DROP_A: SessionUser = {
  ...SENIOR,
  id: 'cb330000-0000-4000-bb00-000000000002',
  email: 'dpca-drop-a@test.spec',
  displayName: 'DPCA Drop A',
  role: 'DROP',
}
const DROP_B: SessionUser = {
  ...SENIOR,
  id: 'cb330000-0000-4000-bb00-000000000003',
  email: 'dpca-drop-b@test.spec',
  displayName: 'DPCA Drop B',
  role: 'DROP',
}
const ACCOUNTANT: SessionUser = {
  ...SENIOR,
  id: 'cb330000-0000-4000-bb00-000000000006',
  email: 'dpca-accountant@test.spec',
  displayName: 'DPCA Accountant',
  role: 'ACCOUNTANT',
  seniorSharePercent: 0,
}
// Seed admins (cascade hardcoded ids) — kept as ADMIN so a (now-removed) split
// loop would have SUCCEEDED, making the "0 PAYOUT_ADMIN" assertion a real guard.
const ADMIN_MAKSYM: SessionUser = {
  ...SENIOR,
  id: MAKSYM_ID,
  email: 'dpca-maksym@test.spec',
  displayName: 'DPCA Maksym',
  role: 'ADMIN',
  seniorSharePercent: 0,
}
const ADMIN_KOSTYA: SessionUser = {
  ...ADMIN_MAKSYM,
  id: KOSTYA_ID,
  email: 'dpca-kostya@test.spec',
  displayName: 'DPCA Kostya',
}

const TEST_OWN_USERS = [SENIOR, DROP_A, DROP_B, ACCOUNTANT]
const TEST_OWN_USER_IDS = TEST_OWN_USERS.map((u) => u.id)
const SEED_ADMINS = [ADMIN_MAKSYM, ADMIN_KOSTYA]
const ACCOUNT_ID = 'cb330000-0000-4000-cc00-000000000001'
const DROP_PROJECT_A = 'cb330000-0000-4000-dd00-000000000001'
const DROP_PROJECT_B = 'cb330000-0000-4000-dd00-000000000002'
const SENIOR_PROJECT = 'cb330000-0000-4000-dd00-000000000003'

const DROP_SHARE = 5
const SENIOR_SHARE = 26

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

// Fixed-rate NBU stub (USDT incomes → identity; never hits network).
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
    {
      provide: PendingSettlementService,
      useFactory: (db: DatabaseService) => new PendingSettlementService(db, stubInvoices as never),
      inject: [DatabaseService],
    },
  ],
})
class DpcaTestModule {}

describe('drop payout → company account + senior obligation (real DB)', () => {
  let svc: TransactionsService
  let companySvc: CompanyAccountService
  let settleSvc: PendingSettlementService
  let dbSvc: DatabaseService

  async function clearLedger() {
    await dbSvc.db
      .delete(pendingObligations)
      .where(inArray(pendingObligations.creditorUserId, TEST_OWN_USER_IDS))
    await dbSvc.db.delete(transactions).where(inArray(transactions.createdBy, TEST_OWN_USER_IDS))
    await dbSvc.db.delete(transactions).where(inArray(transactions.senderId, TEST_OWN_USER_IDS))
    await dbSvc.db.delete(transactions).where(inArray(transactions.receiverId, TEST_OWN_USER_IDS))
    await dbSvc.db.delete(payoutRequests).where(inArray(payoutRequests.seniorId, TEST_OWN_USER_IDS))
  }

  async function displayBalance(): Promise<number> {
    return (await companySvc.getAccount(ADMIN_MAKSYM)).balance
  }
  async function gateBalance(): Promise<number> {
    return computeCompanyAccountBalanceFromLedger(dbSvc.db)
  }

  async function rowsByType(requestId: string, type: string): Promise<string[]> {
    const rows = await dbSvc.db
      .select({ amount: transactions.amount })
      .from(transactions)
      .where(and(eq(transactions.payoutRequestId, requestId), eq(transactions.type, type)))
    return rows.map((r) => r.amount)
  }

  async function pendingObligationsFor(
    seniorId: string,
  ): Promise<
    { amount: string; debtorType: string; status: string; sourceTransactionId: string }[]
  > {
    const rows = await dbSvc.db
      .select({
        amount: pendingObligations.amount,
        debtorType: pendingObligations.debtorType,
        status: pendingObligations.status,
        sourceTransactionId: pendingObligations.sourceTransactionId,
      })
      .from(pendingObligations)
      .where(eq(pendingObligations.creditorUserId, seniorId))
    return rows
  }

  // Seed a VALIDATED DROP_INCOME owned by `dropOwner` on a drop-project (senior
  // = SENIOR). Returns the income id so the test drives the REAL drop flow:
  // createPayoutRequest([incomeId]) then payPayoutRequest.
  async function seedValidatedDropIncome(
    projectId: string,
    dropOwner: SessionUser,
    amount: string,
  ): Promise<string> {
    await dbSvc.db
      .insert(projects)
      .values({
        id: projectId,
        name: `DPCA Drop ${projectId.slice(-4)}`,
        companyName: 'DPCA DropCorp',
        domain: 'fintech',
        startDate: new Date('2025-01-01'),
        seniorId: SENIOR.id,
        dropId: dropOwner.id,
        currency: 'USDT',
        rate: 1000,
      })
      .onConflictDoNothing()

    const [income] = await dbSvc.db
      .insert(transactions)
      .values({
        type: 'DROP_INCOME',
        status: 'VALIDATED',
        amount,
        currency: 'USDT',
        senderId: null,
        senderLabel: 'DPCA DropCorp',
        receiverId: dropOwner.id,
        recipientId: dropOwner.id,
        projectId,
        createdBy: dropOwner.id,
      })
      .returning()
    return income!.id
  }

  async function seedValidatedSeniorIncome(amount: string): Promise<string> {
    const [income] = await dbSvc.db
      .insert(transactions)
      .values({
        type: 'SENIOR_INCOME',
        status: 'VALIDATED',
        amount,
        currency: 'USDT',
        receiverId: SENIOR.id,
        projectId: SENIOR_PROJECT,
        seniorSharePercent: SENIOR_SHARE,
        createdBy: SENIOR.id,
      })
      .returning()
    return income!.id
  }

  beforeAll(async () => {
    try {
      const probe = new Pool({ connectionString: process.env['DATABASE_URL'] })
      await probe.query('SELECT 1')
      const check = await probe.query(
        `SELECT table_name FROM information_schema.tables WHERE table_name='pending_obligations' LIMIT 1`,
      )
      await probe.end()
      if (check.rowCount === 0) {
        console.warn('[drop-payout-company-account] SKIPPED — pending_obligations not found')
        dbAvailable = false
        return
      }
    } catch {
      console.warn('[drop-payout-company-account] SKIPPED — no DB reachable at DATABASE_URL')
      dbAvailable = false
      return
    }

    const moduleRef = await Test.createTestingModule({ imports: [DpcaTestModule] }).compile()
    await moduleRef.init()
    svc = moduleRef.get(TransactionsService)
    companySvc = moduleRef.get(CompanyAccountService)
    settleSvc = moduleRef.get(PendingSettlementService)
    dbSvc = moduleRef.get(DatabaseService)

    const db = dbSvc.db
    await db
      .delete(projects)
      .where(inArray(projects.id, [DROP_PROJECT_A, DROP_PROJECT_B, SENIOR_PROJECT]))
    await clearLedger()
    await db.delete(users).where(inArray(users.id, TEST_OWN_USER_IDS))
    await db
      .insert(users)
      .values(
        [...TEST_OWN_USERS, ...SEED_ADMINS].map((u) => ({
          id: u.id,
          email: u.email,
          displayName: u.displayName,
          role: u.role,
          seniorSharePercent: u.seniorSharePercent,
          ...(u.role === 'DROP' ? { dropSharePercent: DROP_SHARE } : {}),
          googleId: `test-google-${u.id}`,
        })),
      )
      .onConflictDoNothing()

    await db
      .insert(projects)
      .values({
        id: SENIOR_PROJECT,
        name: 'DPCA Senior Project',
        companyName: 'DPCA SeniorCorp',
        domain: 'ai',
        startDate: new Date('2025-01-01'),
        seniorId: SENIOR.id,
        dropId: null,
        currency: 'USDT',
        rate: 1000,
      })
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
    await clearLedger()
    verifyScript.clear()
  })

  afterAll(async () => {
    if (!dbAvailable) return
    try {
      await clearLedger()
      await dbSvc.db
        .delete(projects)
        .where(inArray(projects.id, [DROP_PROJECT_A, DROP_PROJECT_B, SENIOR_PROJECT]))
      await dbSvc.db.delete(users).where(inArray(users.id, TEST_OWN_USER_IDS))
    } catch {
      // non-fatal
    }
    await _pool?.end()
  }, 15_000)

  // ── INV1: drop payout → company += payable; PAYOUT_DROP; SENIOR_PENDING + obligation; 0 PAYOUT_ADMIN
  it('INV1 drop payout PAID → company += I*(1-d%) once; PAYOUT_DROP=I*d%; SENIOR_PENDING_PAYOUT + obligation=I*s%; 0 PAYOUT_ADMIN', async () => {
    if (!dbAvailable) return
    const I = 1000
    const before = await displayBalance()
    const incomeId = await seedValidatedDropIncome(DROP_PROJECT_A, DROP_A, String(I))

    // Real drop flow: bundle own validated income → payout_request.
    const pr = await svc.createPayoutRequest([incomeId], DROP_A)
    const payable = parseFloat(pr.payableAmount)
    // payable = I * (1 - dropShare%) = 1000 * 0.95 = 950
    expect(payable).toBeCloseTo(I * (1 - DROP_SHARE / 100), 6)

    const HASH = '0x' + 'd'.repeat(64)
    verifyScript.set(HASH, {
      found: true,
      toMatches: true,
      confirmed: true,
      confirmations: THRESHOLD,
      amountUsdt: payable,
    })
    const result = await svc.payPayoutRequest(pr.id, HASH, DROP_A)
    expect(result.status).toBe('PAID')

    // Company credited the full payable, exactly once.
    expect(await displayBalance()).toBeCloseTo(before + payable, 6)

    // No legacy partner split.
    expect(await rowsByType(pr.id, 'PAYOUT_ADMIN')).toHaveLength(0)

    // Drop's slice = I * d% = 50.
    const dropRows = await rowsByType(pr.id, 'PAYOUT_DROP')
    expect(dropRows).toHaveLength(1)
    expect(parseFloat(dropRows[0]!)).toBeCloseTo((I * DROP_SHARE) / 100, 6)

    // Senior IOU row + obligation = I * s% = 260.
    const expectedSenior = (I * SENIOR_SHARE) / 100
    const pendingRows = await rowsByType(pr.id, 'SENIOR_PENDING_PAYOUT')
    expect(pendingRows).toHaveLength(1)
    expect(parseFloat(pendingRows[0]!)).toBeCloseTo(expectedSenior, 6)

    const obligations = await pendingObligationsFor(SENIOR.id)
    expect(obligations).toHaveLength(1)
    expect(parseFloat(obligations[0]!.amount)).toBeCloseTo(expectedSenior, 6)
    expect(obligations[0]!.debtorType).toBe('COMPANY')
    expect(obligations[0]!.status).toBe('PENDING')

    // No double-count: display == gate.
    expect(await displayBalance()).toBeCloseTo(await gateBalance(), 6)
  })

  // ── INV2: settleByCompany closes obligation → senior income, company −= s%
  it('INV2 settleByCompany → senior SENIOR_INCOME += I*s%; company −= I*s%; net company = I*(1-d%-s%)', async () => {
    if (!dbAvailable) return
    const I = 1000
    const beforeAll = await displayBalance()
    const incomeId = await seedValidatedDropIncome(DROP_PROJECT_A, DROP_A, String(I))
    const pr = await svc.createPayoutRequest([incomeId], DROP_A)
    const payable = parseFloat(pr.payableAmount)
    const HASH = '0x' + 'e'.repeat(64)
    verifyScript.set(HASH, {
      found: true,
      toMatches: true,
      confirmed: true,
      confirmations: THRESHOLD,
      amountUsdt: payable,
    })
    await svc.payPayoutRequest(pr.id, HASH, DROP_A)

    const afterPayout = await displayBalance()
    const seniorShare = (I * SENIOR_SHARE) / 100

    // Close the obligation as ACCOUNTANT.
    const [obligation] = await pendingObligationsFor(SENIOR.id)
    expect(obligation).toBeTruthy()
    const obRow = await dbSvc.db.query.pendingObligations.findFirst({
      where: eq(pendingObligations.sourceTransactionId, obligation!.sourceTransactionId),
    })
    const settled = await settleSvc.settleByCompany(obRow!.id, ACCOUNTANT)
    expect(settled.obligation.status).toBe('PAID')

    // Senior received a SENIOR_INCOME (PAID) of exactly seniorShare.
    const seniorIncome = settled.created.find((c) => c.type === 'SENIOR_INCOME')
    expect(seniorIncome).toBeTruthy()
    expect(parseFloat(seniorIncome!.amount)).toBeCloseTo(seniorShare, 6)

    // Company balance dropped by the senior share.
    expect(await displayBalance()).toBeCloseTo(afterPayout - seniorShare, 6)

    // Net company change over the whole flow = I*(1 - d% - s%) = 1000*0.69 = 690.
    const netCompany = (await displayBalance()) - beforeAll
    expect(netCompany).toBeCloseTo((I * (100 - DROP_SHARE - SENIOR_SHARE)) / 100, 6)

    // No drift after settlement.
    expect(await displayBalance()).toBeCloseTo(await gateBalance(), 6)
  })

  // ── INV3: senior-project payout unchanged
  it('INV3 senior-project payout PAID → 0 PAYOUT_DROP / SENIOR_PENDING_PAYOUT / obligation; company += payable once', async () => {
    if (!dbAvailable) return
    const before = await displayBalance()
    const incomeId = await seedValidatedSeniorIncome('1000')
    const pr = await svc.createPayoutRequest([incomeId], SENIOR)
    const payable = parseFloat(pr.payableAmount)
    // senior keeps 26% → company payable = 740.
    expect(payable).toBeCloseTo((1000 * (100 - SENIOR_SHARE)) / 100, 6)

    const HASH = '0x' + 'f'.repeat(64)
    verifyScript.set(HASH, {
      found: true,
      toMatches: true,
      confirmed: true,
      confirmations: THRESHOLD,
      amountUsdt: payable,
    })
    await svc.payPayoutRequest(pr.id, HASH, SENIOR)

    expect(await rowsByType(pr.id, 'PAYOUT_DROP')).toHaveLength(0)
    expect(await rowsByType(pr.id, 'SENIOR_PENDING_PAYOUT')).toHaveLength(0)
    expect(await rowsByType(pr.id, 'PAYOUT_ADMIN')).toHaveLength(0)
    // No senior obligation booked on a senior-project payout.
    expect(await pendingObligationsFor(SENIOR.id)).toHaveLength(0)

    expect(await displayBalance()).toBeCloseTo(before + payable, 6)
    expect(await displayBalance()).toBeCloseTo(await gateBalance(), 6)
  })

  // ── RBAC: drop cannot bundle another drop's income
  it('RBAC DROP A cannot bundle DROP B income via createPayoutRequest → BadRequest', async () => {
    if (!dbAvailable) return
    const incomeBId = await seedValidatedDropIncome(DROP_PROJECT_B, DROP_B, '500')
    // DROP A tries to bundle DROP B's income — the receiverId filter excludes it,
    // count-mismatch guard throws.
    await expect(svc.createPayoutRequest([incomeBId], DROP_A)).rejects.toThrow(
      'Часть транзакций уже включена в выплату или недоступна',
    )
  })

  // ── RBAC: settleByCompany only ADMIN/ACCOUNTANT
  it('RBAC settleByCompany rejects DROP and SENIOR (403)', async () => {
    if (!dbAvailable) return
    const I = 1000
    const incomeId = await seedValidatedDropIncome(DROP_PROJECT_A, DROP_A, String(I))
    const pr = await svc.createPayoutRequest([incomeId], DROP_A)
    const payable = parseFloat(pr.payableAmount)
    const HASH = '0x' + 'c'.repeat(64)
    verifyScript.set(HASH, {
      found: true,
      toMatches: true,
      confirmed: true,
      confirmations: THRESHOLD,
      amountUsdt: payable,
    })
    await svc.payPayoutRequest(pr.id, HASH, DROP_A)

    const [obligation] = await pendingObligationsFor(SENIOR.id)
    const obRow = await dbSvc.db.query.pendingObligations.findFirst({
      where: eq(pendingObligations.sourceTransactionId, obligation!.sourceTransactionId),
    })

    await expect(settleSvc.settleByCompany(obRow!.id, DROP_A)).rejects.toThrow()
    await expect(settleSvc.settleByCompany(obRow!.id, SENIOR)).rejects.toThrow()
    // Still PENDING after the rejected attempts.
    const stillPending = await dbSvc.db.query.pendingObligations.findFirst({
      where: eq(pendingObligations.id, obRow!.id),
    })
    expect(stillPending!.status).toBe('PENDING')
  })
})
