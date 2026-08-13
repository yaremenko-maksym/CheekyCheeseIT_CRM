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
 * task-drop-payout-company-account — REAL-DB integration proving the new DROP
 * settlement model (full senior/drop parity, money on the company account):
 *
 *   A DROP settles a validated DROP_INCOME via the SAME flow as a SENIOR —
 *   createPayoutRequest (bundle own VALIDATED DROP_INCOME) → payPayoutRequest
 *   (on-chain confirm to the COMPANY wallet). The cascade then books:
 *     - PAYOUT row PAID, fundingSource=COMPANY_ACCOUNT → company += payable ONCE.
 *     - DROP_PENDING_PAYOUT (PENDING_PAYMENT, debtor=COMPANY) + a
 *       pending_obligation (creditor=drop, COMPANY) for income * dropShare%
 *       (task-drop-share-pending-parity, 2026-07-27 — the drop's own slice is
 *       no longer an instant PAID PAYOUT_DROP; it requires the SAME
 *       settle-with-receipt confirmation as the senior's share below).
 *     - SENIOR_PENDING_PAYOUT (PENDING_PAYMENT, debtor=COMPANY) + a
 *       pending_obligation (creditor=senior, COMPANY) for income * seniorShare%.
 *     - ZERO PAYOUT_ADMIN (the legacy 50/50 split is gone).
 *
 *   settleByCompany (ADMIN/ACCOUNTANT) then closes each obligation in place:
 *     - senior: SENIOR_PENDING_PAYOUT → SENIOR_INCOME (PAID), company −= s%.
 *     - drop:   DROP_PENDING_PAYOUT → PAYOUT_DROP (PAID), credits the drop.
 *       Settled here with ADMIN_PERSONAL funding — the drop's slice never
 *       landed on the company pool (only `payable` = I*(1-d%) did; the drop
 *       self-keeps its cut before the on-chain transfer). security-review
 *       PR #443 (HIGH-1): settleByCompany now REJECTS a COMPANY_ACCOUNT-funded
 *       settle on a cascade-originated drop obligation with a 400 — see
 *       pending-settlement.service.ts's HIGH-1 guard and the dedicated test
 *       below. ADMIN_PERSONAL is the only funding choice that matches reality
 *       and leaves the shared balance untouched — same principle already
 *       relied on for an admin-declared income that lands in a specific
 *       admin's personal wallet.
 *   Net company after both settles = income*(1−d%−s%).
 *
 * Invariants proven (against the REAL cascade + REAL balance derivation):
 *   INV1  drop payout PAID → company += payable (once); DROP_PENDING_PAYOUT
 *         (PENDING_PAYMENT) = I*d% — NOT yet a PAYOUT_DROP;
 *         SENIOR_PENDING_PAYOUT + obligation = I*s%; 0 PAYOUT_ADMIN.
 *   INV2  settleByCompany(senior) → SENIOR_INCOME += I*s%; company −= I*s%.
 *         settleByCompany(drop, ADMIN_PERSONAL) → PAYOUT_DROP += I*d%; company
 *         balance UNCHANGED by the drop settle. Net company = I*(1−d%−s%).
 *   INV3  senior payout (senior-project) unchanged → 0 DROP_PENDING_PAYOUT /
 *         PAYOUT_DROP / pending, company += payable once.
 *   INV4  display balance (getAccount) == gate balance (ledger SSOT) — no drift,
 *         no double-counting at any step.
 *   AC4   settling the drop obligation WITHOUT a receipt is rejected.
 *   HIGH-1 settling the drop obligation with COMPANY_ACCOUNT funding is
 *         rejected (400) — the money never touched the company pool; company
 *         balance is unchanged by the rejected attempt.
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
const verifyScript = new Map<string, ScriptedVerification>()
const fakeEtherscan: Pick<EtherscanService, 'verifyDeposit'> = {
  verifyDeposit: (txHash: string): Promise<DepositVerification> =>
    Promise.resolve(withDerivedMinorUnits(verifyScript.get(txHash))),
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
      useFactory: (db: DatabaseService) =>
        new PendingSettlementService(db, stubInvoices as never, fakeNbu as NbuCurrencyService),
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

  /** MED-2 (security-review PR #443, round 4): seed a DROP_PENDING_PAYOUT
   * COMPANY obligation the SAME way a row OLDER than the `drop_cascade_origin`
   * column would look — the column is simply never mentioned in the insert,
   * so it stays NULL (Drizzle omits unset fields; the column is nullable with
   * no default — see schema.ts). This is exactly the "row older than the
   * column" state a `db:push`-provisioned integration DB can never otherwise
   * produce (push always creates every column from the CURRENT schema), so it
   * must be constructed explicitly to exercise the fail-safe branch at all. */
  async function seedUnstampedDropObligation(amount: string): Promise<{ obligationId: string }> {
    // Self-contained (order-independent): `beforeAll` only DELETEs
    // DROP_PROJECT_A (the other helpers, e.g. seedValidatedDropIncome,
    // upsert it lazily) — upsert it here too so this test does not silently
    // depend on an earlier test in this file having already created it
    // (caught by running this test in isolation via `-t`).
    await dbSvc.db
      .insert(projects)
      .values({
        id: DROP_PROJECT_A,
        name: 'DPCA Drop dd01',
        companyName: 'DPCA DropCorp',
        domain: 'fintech',
        startDate: new Date('2025-01-01'),
        seniorId: SENIOR.id,
        dropId: DROP_A.id,
        currency: 'USDT',
        rate: 1000,
      })
      .onConflictDoNothing()

    const [tx] = await dbSvc.db
      .insert(transactions)
      .values({
        type: 'DROP_PENDING_PAYOUT',
        status: 'PENDING_PAYMENT',
        amount,
        currency: 'USDT',
        senderLabel: 'COMPANY',
        receiverId: DROP_A.id,
        recipientId: DROP_A.id,
        projectId: DROP_PROJECT_A,
        createdBy: ADMIN_MAKSYM.id,
        // dropCascadeOrigin: deliberately NOT set — must stay NULL.
      })
      .returning()
    const [obligation] = await dbSvc.db
      .insert(pendingObligations)
      .values({
        creditorUserId: DROP_A.id,
        debtorType: 'COMPANY',
        debtorUserId: null,
        sourceTransactionId: tx!.id,
        amount,
        currency: 'USDT',
        status: 'PENDING',
      })
      .returning()
    return { obligationId: obligation!.id }
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

  // ── INV1: drop payout → company += payable; DROP_PENDING_PAYOUT; SENIOR_PENDING + obligation; 0 PAYOUT_ADMIN
  it('INV1 drop payout PAID → company += I*(1-d%) once; DROP_PENDING_PAYOUT=I*d% (pending, NOT PAYOUT_DROP yet); SENIOR_PENDING_PAYOUT + obligation=I*s%; 0 PAYOUT_ADMIN', async () => {
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

    // task-drop-share-pending-parity: the drop's slice is NOT an instant
    // PAYOUT_DROP anymore — it is a PENDING_PAYMENT COMPANY debt, same shape
    // as the senior's, until an ADMIN/ACCOUNTANT settles it with a receipt.
    expect(await rowsByType(pr.id, 'PAYOUT_DROP')).toHaveLength(0)
    const dropPendingRows = await rowsByType(pr.id, 'DROP_PENDING_PAYOUT')
    expect(dropPendingRows).toHaveLength(1)
    expect(parseFloat(dropPendingRows[0]!)).toBeCloseTo((I * DROP_SHARE) / 100, 6)

    const dropObligations = await pendingObligationsFor(DROP_A.id)
    expect(dropObligations).toHaveLength(1)
    expect(parseFloat(dropObligations[0]!.amount)).toBeCloseTo((I * DROP_SHARE) / 100, 6)
    expect(dropObligations[0]!.debtorType).toBe('COMPANY')
    expect(dropObligations[0]!.status).toBe('PENDING')

    // Senior IOU row + obligation = I * s% = 260 (unchanged by this task).
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

  // ── INV2b (task-drop-share-pending-parity, AC1-3): drop settle → PAYOUT_DROP,
  // drop's OWN balance moves only after settle; company balance untouched by
  // an ADMIN_PERSONAL-funded drop settle (the money never sat in the pool).
  it('INV2b settleByCompany(drop, ADMIN_PERSONAL) → PAYOUT_DROP += I*d%; drop balance 0 before / +I*d% after; company balance unchanged', async () => {
    if (!dbAvailable) return
    const I = 1000
    const incomeId = await seedValidatedDropIncome(DROP_PROJECT_A, DROP_A, String(I))
    const pr = await svc.createPayoutRequest([incomeId], DROP_A)
    const payable = parseFloat(pr.payableAmount)
    const HASH = '0x' + 'a'.repeat(64)
    verifyScript.set(HASH, {
      found: true,
      toMatches: true,
      confirmed: true,
      confirmations: THRESHOLD,
      amountUsdt: payable,
    })
    await svc.payPayoutRequest(pr.id, HASH, DROP_A)

    const dropShare = (I * DROP_SHARE) / 100

    // AC3: drop's own balance does NOT move while the obligation is PENDING.
    const beforeDropSettle = (await svc.getDropSelfSummary(DROP_A)).balance
    const beforeCompanyBalance = await displayBalance()

    const [dropObligation] = await pendingObligationsFor(DROP_A.id)
    expect(dropObligation).toBeTruthy()
    const dropObRow = await dbSvc.db.query.pendingObligations.findFirst({
      where: eq(pendingObligations.sourceTransactionId, dropObligation!.sourceTransactionId),
    })

    // ADMIN_PERSONAL — see the file-header note: the drop's slice never
    // touched the company pool, so this is the funding choice that matches
    // reality and keeps the shared balance untouched.
    const settled = await settleSvc.settleByCompany(dropObRow!.id, ACCOUNTANT, {
      fundingSource: 'ADMIN_PERSONAL',
      payerAdminId: ADMIN_MAKSYM.id,
      receiptExternalUrl: 'https://etherscan.io/tx/0xdropcompanyaccountinv2b001',
    })
    expect(settled.obligation.status).toBe('PAID')

    const payoutDrop = settled.created.find((c) => c.type === 'PAYOUT_DROP')
    expect(payoutDrop).toBeTruthy()
    expect(parseFloat(payoutDrop!.amount)).toBeCloseTo(dropShare, 6)
    // In-place flip (task-settle-in-place): the flipped row reuses the SAME
    // id as the source DROP_PENDING_PAYOUT — no second transaction.
    expect(payoutDrop!.id).toBe(dropObRow!.sourceTransactionId)

    // AC3: drop balance increases by EXACTLY the same amount a direct
    // PAYOUT_DROP would have credited (regression on the distribution math).
    const afterDropSettle = (await svc.getDropSelfSummary(DROP_A)).balance
    expect(afterDropSettle - beforeDropSettle).toBeCloseTo(dropShare, 6)

    // ADMIN_PERSONAL settle never touches the shared company account.
    expect(await displayBalance()).toBeCloseTo(beforeCompanyBalance, 6)
    expect(await displayBalance()).toBeCloseTo(await gateBalance(), 6)
  })

  // ── AC4: settling the drop obligation WITHOUT a receipt is rejected ────────
  it('AC4 settle drop obligation WITHOUT a receipt → BadRequest; obligation stays PENDING', async () => {
    if (!dbAvailable) return
    const I = 1000
    const incomeId = await seedValidatedDropIncome(DROP_PROJECT_A, DROP_A, String(I))
    const pr = await svc.createPayoutRequest([incomeId], DROP_A)
    const payable = parseFloat(pr.payableAmount)
    const HASH = '0x' + 'b'.repeat(64)
    verifyScript.set(HASH, {
      found: true,
      toMatches: true,
      confirmed: true,
      confirmations: THRESHOLD,
      amountUsdt: payable,
    })
    await svc.payPayoutRequest(pr.id, HASH, DROP_A)

    const [dropObligation] = await pendingObligationsFor(DROP_A.id)
    const dropObRow = await dbSvc.db.query.pendingObligations.findFirst({
      where: eq(pendingObligations.sourceTransactionId, dropObligation!.sourceTransactionId),
    })

    await expect(
      settleSvc.settleByCompany(dropObRow!.id, ACCOUNTANT, {
        fundingSource: 'ADMIN_PERSONAL',
        payerAdminId: ADMIN_MAKSYM.id,
      }),
    ).rejects.toThrow(/Чек обязателен/)

    const stillPending = await dbSvc.db.query.pendingObligations.findFirst({
      where: eq(pendingObligations.id, dropObRow!.id),
    })
    expect(stillPending!.status).toBe('PENDING')
  })

  // ── HIGH-1 (security-review PR #443): settling a cascade-originated drop
  // obligation with COMPANY_ACCOUNT funding must be REJECTED — that money
  // never touched the company pool (only `payable = I*(1-d%)` did). Without
  // this guard the settle would silently debit money the company never held,
  // understating the balance by exactly the drop's share on every such
  // settle. Proves the server is the authority, independent of the UI.
  it('HIGH-1 settle drop obligation (cascade origin) with COMPANY_ACCOUNT → 400; company balance unchanged; obligation stays PENDING', async () => {
    if (!dbAvailable) return
    const I = 1000
    const before = await displayBalance()
    const incomeId = await seedValidatedDropIncome(DROP_PROJECT_A, DROP_A, String(I))
    const pr = await svc.createPayoutRequest([incomeId], DROP_A)
    const payable = parseFloat(pr.payableAmount)
    const HASH = '0x' + '9'.repeat(64)
    verifyScript.set(HASH, {
      found: true,
      toMatches: true,
      confirmed: true,
      confirmations: THRESHOLD,
      amountUsdt: payable,
    })
    await svc.payPayoutRequest(pr.id, HASH, DROP_A)

    const afterPayout = await displayBalance()
    const [dropObligation] = await pendingObligationsFor(DROP_A.id)
    const dropObRow = await dbSvc.db.query.pendingObligations.findFirst({
      where: eq(pendingObligations.sourceTransactionId, dropObligation!.sourceTransactionId),
    })

    // Explicit COMPANY_ACCOUNT (WITH a valid receipt — the receipt gate is
    // NOT what should block this; the HIGH-1 guard runs before it).
    await expect(
      settleSvc.settleByCompany(dropObRow!.id, ACCOUNTANT, {
        fundingSource: 'COMPANY_ACCOUNT',
        receiptExternalUrl: 'https://etherscan.io/tx/0xdropcompanyaccounthigh1001',
      }),
    ).rejects.toThrow(/не проходила через счёт компании/)

    // Legacy no-funding call ALSO defaults to COMPANY_ACCOUNT for a COMPANY
    // debt (useCompanyAccount=isCompanyDebt) — the guard covers this branch too.
    await expect(settleSvc.settleByCompany(dropObRow!.id, ACCOUNTANT)).rejects.toThrow(
      /не проходила через счёт компании/,
    )

    // No money moved, obligation untouched — the rejected attempts are pure no-ops.
    expect(await displayBalance()).toBeCloseTo(afterPayout, 6)
    expect(await displayBalance()).toBeCloseTo(before + payable, 6)
    const stillPending = await dbSvc.db.query.pendingObligations.findFirst({
      where: eq(pendingObligations.id, dropObRow!.id),
    })
    expect(stillPending!.status).toBe('PENDING')

    // Sanity: the SAME obligation settles fine via ADMIN_PERSONAL (the guard
    // targets the funding CHOICE, not the obligation itself).
    const settled = await settleSvc.settleByCompany(dropObRow!.id, ACCOUNTANT, {
      fundingSource: 'ADMIN_PERSONAL',
      payerAdminId: ADMIN_MAKSYM.id,
      receiptExternalUrl: 'https://etherscan.io/tx/0xdropcompanyaccounthigh1002',
    })
    expect(settled.obligation.status).toBe('PAID')
    expect(await displayBalance()).toBeCloseTo(afterPayout, 6)
  })

  // ── MED-1 (security-review PR #443, round 3): the guard must survive the
  // FK being nulled — this is the ENTIRE reason MED-B replaced the
  // payout_request_id-based predicate with the drop_cascade_origin marker.
  // Without this test, reverting the guard back to `sourcePayoutRequestId
  // !== null` would leave the whole suite green (HIGH-1 above never nulls
  // the FK, so both predicates agree there).
  it('MED-1 settle rejected via drop_cascade_origin even after payout_request_id is nulled (simulates a future payout_requests cleanup, ON DELETE SET NULL)', async () => {
    if (!dbAvailable) return
    const I = 1000
    const incomeId = await seedValidatedDropIncome(DROP_PROJECT_A, DROP_A, String(I))
    const pr = await svc.createPayoutRequest([incomeId], DROP_A)
    const payable = parseFloat(pr.payableAmount)
    const HASH = '0x' + '8'.repeat(64)
    verifyScript.set(HASH, {
      found: true,
      toMatches: true,
      confirmed: true,
      confirmations: THRESHOLD,
      amountUsdt: payable,
    })
    await svc.payPayoutRequest(pr.id, HASH, DROP_A)

    const afterPayout = await displayBalance()
    const [dropObligation] = await pendingObligationsFor(DROP_A.id)
    const dropObRow = await dbSvc.db.query.pendingObligations.findFirst({
      where: eq(pendingObligations.sourceTransactionId, dropObligation!.sourceTransactionId),
    })

    // Simulate the exact scenario MED-B was written for: some unrelated,
    // future cleanup of `payout_requests` fires the FK's `ON DELETE SET
    // NULL` and nulls this row's payout_request_id — WITHOUT going through
    // settleByCompany (which is the only code path allowed to legitimately
    // flip this obligation).
    await dbSvc.db
      .update(transactions)
      .set({ payoutRequestId: null })
      .where(eq(transactions.id, dropObRow!.sourceTransactionId))

    const sourceAfterFkLoss = await dbSvc.db.query.transactions.findFirst({
      where: eq(transactions.id, dropObRow!.sourceTransactionId),
    })
    // Sanity: the FK is genuinely gone, but the marker this guard actually
    // reads is untouched — proves the two signals have DIVERGED, which is
    // exactly the state under which the old (payout_request_id-based) and
    // the new (drop_cascade_origin-based) predicates disagree.
    expect(sourceAfterFkLoss!.payoutRequestId).toBeNull()
    expect(sourceAfterFkLoss!.dropCascadeOrigin).toBe(true)

    await expect(
      settleSvc.settleByCompany(dropObRow!.id, ACCOUNTANT, {
        fundingSource: 'COMPANY_ACCOUNT',
        receiptExternalUrl: 'https://etherscan.io/tx/0xdropcompanyaccountmed1r3001',
      }),
    ).rejects.toThrow(/не проходила через счёт компании/)

    // No money moved, obligation untouched.
    expect(await displayBalance()).toBeCloseTo(afterPayout, 6)
    const stillPending = await dbSvc.db.query.pendingObligations.findFirst({
      where: eq(pendingObligations.id, dropObRow!.id),
    })
    expect(stillPending!.status).toBe('PENDING')
  })

  // ── MED-2 (security-review PR #443, round 4): the NULL/"unstamped marker"
  // branch of the fail-safe guard was never exercised by any spec — a
  // `db:push`-provisioned integration DB always creates every column fresh
  // from the CURRENT schema, so "a row older than the column" can never
  // arise organically; it has to be constructed explicitly (see
  // seedUnstampedDropObligation). This pins the exact polarity the guard
  // must use: `!== false` (blocks null), NOT a truthy check (`null &&` is
  // falsy and would WRONGLY allow — see the HIGH-1 marker migration's own
  // header for why NULL means "unknown", not "safe").
  it('MED-2 settle rejected for an UNSTAMPED drop_cascade_origin (NULL — row older than the column); explicit false still settles fine', async () => {
    if (!dbAvailable) return
    const before = await displayBalance()
    const { obligationId } = await seedUnstampedDropObligation('30')

    const row = await dbSvc.db.query.pendingObligations.findFirst({
      where: eq(pendingObligations.id, obligationId),
    })
    const sourceTx = await dbSvc.db.query.transactions.findFirst({
      where: eq(transactions.id, row!.sourceTransactionId),
    })
    // Sanity: genuinely NULL, not accidentally false/true.
    expect(sourceTx!.dropCascadeOrigin).toBeNull()

    await expect(
      settleSvc.settleByCompany(obligationId, ACCOUNTANT, {
        fundingSource: 'COMPANY_ACCOUNT',
        receiptExternalUrl: 'https://etherscan.io/tx/0xdropcompanyaccountmed2r4001',
      }),
    ).rejects.toThrow(/не проходила через счёт компании/)

    // No money moved, obligation untouched by the rejected attempt.
    expect(await displayBalance()).toBeCloseTo(before, 6)
    const stillPending = await dbSvc.db.query.pendingObligations.findFirst({
      where: eq(pendingObligations.id, obligationId),
    })
    expect(stillPending!.status).toBe('PENDING')

    // Once the row is EXPLICITLY marked false (mirrors the HIGH-1 marker
    // migration's own backfill), the SAME obligation settles fine from
    // COMPANY_ACCOUNT — proves the guard reacts to the marker's VALUE, not
    // to some other property of this seeded row. This obligation was
    // seeded directly (not via a real payPayoutRequest cascade), so unlike
    // every OTHER test in this file the company account was never credited
    // for it — fund it explicitly first, or the balance gate legitimately
    // (and correctly) rejects with "Недостаточно средств…" on a freshly
    // seeded CI database (a real CI failure this test caught — round 5).
    // Tagged with a TEST_OWN_USER_IDS creator so clearLedger() reclaims it.
    await dbSvc.db.insert(transactions).values({
      type: 'COMPANY_DEPOSIT',
      status: 'PAID',
      amount: '1000',
      currency: 'USDT',
      senderLabel: 'MED-2 test funding',
      createdBy: ACCOUNTANT.id,
    })
    await dbSvc.db
      .update(transactions)
      .set({ dropCascadeOrigin: false })
      .where(eq(transactions.id, row!.sourceTransactionId))
    const beforeSecondSettle = await displayBalance()
    const settled = await settleSvc.settleByCompany(obligationId, ACCOUNTANT, {
      fundingSource: 'COMPANY_ACCOUNT',
      receiptExternalUrl: 'https://etherscan.io/tx/0xdropcompanyaccountmed2r4002',
    })
    expect(settled.obligation.status).toBe('PAID')
    expect(await displayBalance()).toBeCloseTo(beforeSecondSettle - 30, 6)
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
