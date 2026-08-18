import { Global, Module } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq, inArray } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { MAKSYM_ID, KOSTYA_ID, COMPANY_ACCOUNT_RECEIVER } from '@crm/shared'

import { DatabaseService } from '../database/database.service'
import { CompanyAccountService } from './company-account.service'
import { PendingSettlementService } from './pending-settlement.service'
import { TransactionsService } from './transactions.service'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'
import { sweepOrphanConsumedTxHashes } from './__test-helpers__/consumed-tx-hashes'
import { computeCompanyAccountBalanceFromLedger } from './company-account-balance'
import type { EtherscanService } from './etherscan.service'
import type { NbuCurrencyService } from './nbu-currency.service'
import {
  companyAccount,
  consumedTxHashes,
  payoutRequests,
  pendingObligations,
  projects,
  transactions,
  users,
} from '../database/schema'
import * as schema from '../database/schema'
import { hasDatabaseUrl } from '../test/require-real-db'

/**
 * task-drop-share-override-and-receiver — REAL-DB integration for the admin-USDT
 * income → obligations → settle flow, and the paymentType declaration gate.
 *
 * Proven against the REAL services + REAL DB (crm_qa), NOT mocked (urban
 * feedback_mocked_e2e_guards): declareUsdtProjectIncome atomically books
 * SENIOR_PENDING_PAYOUT + DROP_PENDING_PAYOUT obligations; settleByCompany
 * branches DROP_PENDING_PAYOUT → PAYOUT_DROP (credits the drop, no invoice);
 * the ledger and totalIncome (C4) stay consistent.
 *
 * Run against a scratch DB (NEVER the live crm_db):
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_qa \
 *     pnpm --filter @crm/api test -- usdt-income-obligations.integration
 */

const SENIOR: SessionUser = {
  id: 'ce440000-0000-4000-bb00-000000000001',
  email: 'usdt-senior@test.spec',
  displayName: 'USDT Senior',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}
const DROP: SessionUser = {
  ...SENIOR,
  id: 'ce440000-0000-4000-bb00-000000000002',
  email: 'usdt-drop@test.spec',
  displayName: 'USDT Drop',
  role: 'DROP',
}
const ACCOUNTANT: SessionUser = {
  ...SENIOR,
  id: 'ce440000-0000-4000-bb00-000000000006',
  email: 'usdt-accountant@test.spec',
  displayName: 'USDT Accountant',
  role: 'ACCOUNTANT',
  seniorSharePercent: 0,
}
const JUNIOR: SessionUser = {
  ...SENIOR,
  id: 'ce440000-0000-4000-bb00-000000000007',
  email: 'usdt-junior@test.spec',
  displayName: 'USDT Junior',
  role: 'JUNIOR',
  seniorSharePercent: 0,
}
const ADMIN_MAKSYM: SessionUser = {
  ...SENIOR,
  id: MAKSYM_ID,
  email: 'usdt-maksym@test.spec',
  displayName: 'USDT Maksym',
  role: 'ADMIN',
  seniorSharePercent: 0,
}
const ADMIN_KOSTYA: SessionUser = {
  ...ADMIN_MAKSYM,
  id: KOSTYA_ID,
  email: 'usdt-kostya@test.spec',
  displayName: 'USDT Kostya',
}

const TEST_OWN_USERS = [SENIOR, DROP, ACCOUNTANT, JUNIOR]
const TEST_OWN_USER_IDS = TEST_OWN_USERS.map((u) => u.id)

const ACCOUNT_ID = 'ce440000-0000-4000-cc00-000000000001'
const USDT_DROP_PROJECT = 'ce440000-0000-4000-dd00-000000000001'
const USDT_SENIOR_PROJECT = 'ce440000-0000-4000-dd00-000000000002'
const FOP_DROP_PROJECT = 'ce440000-0000-4000-dd00-000000000003'
const USDT_OVERRIDE_PROJECT = 'ce440000-0000-4000-dd00-000000000004'
const MY_PROJECT_IDS = [
  USDT_DROP_PROJECT,
  USDT_SENIOR_PROJECT,
  FOP_DROP_PROJECT,
  USDT_OVERRIDE_PROJECT,
]
// Unique marker on the pool-funding COMPANY_DEPOSIT so cleanup can target ONLY
// this spec's deposit (it has no projectId) without touching seed/other rows.
const DEPOSIT_LABEL = 'usdt-spec-deposit'

const DROP_SHARE = 5
const SENIOR_SHARE = 26
const DROP_OVERRIDE = 12
const WALLET = '0xC0FFEE0000000000000000000000000000000abc'

const fakeNbu: Pick<NbuCurrencyService, 'getRates'> = {
  getRates: () =>
    Promise.resolve({ usdUah: '40.0000', usdtUah: '40.0000', eurUah: '44.0000', date: '20260620' }),
}
const fakeEtherscan = {
  verifyDeposit: () =>
    Promise.resolve({
      found: false,
      toMatches: false,
      confirmed: false,
      confirmations: 0,
      amountUsdt: null,
    }),
} as unknown as EtherscanService

let seniorInvoiceTriggers = 0
const stubInvoices = {
  autoCreateForPayout: () => Promise.resolve(),
  autoCreateForSeniorPayout: () => {
    seniorInvoiceTriggers += 1
    return Promise.resolve()
  },
  autoCreateForSalary: () => Promise.resolve(),
} as never
const stubDocuments = {} as never

let _pool: Pool | null = null

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
          etherscanService: fakeEtherscan,
        }),
      inject: [DatabaseService],
    },
    {
      provide: CompanyAccountService,
      useFactory: (db: DatabaseService) => new CompanyAccountService(db, fakeEtherscan),
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
class UsdtTestModule {}

describe.skipIf(!hasDatabaseUrl())('admin-USDT income → obligations → settle (real DB)', () => {
  let svc: TransactionsService
  let settleSvc: PendingSettlementService
  let dbSvc: DatabaseService

  // PR #367 (MED-1): declareUsdtProjectIncome now REQUIRES a client idempotency
  // key. Every declaration in THIS spec is a distinct income, so each gets a
  // fresh UUID (idempotency semantics — replay / race / no double-book — are
  // proven separately in usdt-income-idempotency.integration.spec.ts). The
  // helper keeps these obligation/settle/ledger tests focused on their behavior.
  // task-receipts-backend (review round 1): declareUsdtProjectIncome now
  // REQUIRES a mandatory explorer-link receipt (USDT → explorer-only). None of
  // this spec's declare() calls exercise the receipt itself (that is covered by
  // finance.receipts.spec.ts + transaction-receipt-attach.integration.spec.ts),
  // so the helper injects a fixed, valid explorer url by default — every
  // existing call site keeps testing obligation/settle/ledger behavior
  // unchanged. A caller MAY still override receiptExternalUrl explicitly.
  function declare(
    body: Omit<Parameters<TransactionsService['declareUsdtProjectIncome']>[0], 'idempotencyKey'>,
    user: SessionUser,
  ) {
    return svc.declareUsdtProjectIncome(
      {
        receiptExternalUrl: 'https://etherscan.io/tx/0xusdtincomeobligationsspec',
        ...body,
        idempotencyKey: randomUUID(),
      },
      user,
    )
  }

  // task-receipts-backend (review round 1): settleByCompany now requires a
  // mandatory receipt whenever a `funding` object is supplied — every funding
  // shape this spec exercises (COMPANY_ACCOUNT, or ADMIN_PERSONAL with
  // currency USDT) resolves to an EFFECTIVE currency of USDT → explorer-only.
  // Wrap the service call so every settle() call site keeps testing
  // obligation/ledger/invoice/RBAC behavior, not the receipt gate itself
  // (covered by finance.receipts.spec.ts + transaction-receipt-attach
  // .integration.spec.ts).
  function settle(
    obligationId: string,
    user: SessionUser,
    funding: NonNullable<Parameters<PendingSettlementService['settleByCompany']>[2]>,
  ) {
    return settleSvc.settleByCompany(obligationId, user, {
      receiptExternalUrl: 'https://etherscan.io/tx/0xusdtincomeobligationsspec',
      ...funding,
    })
  }

  // Surgical cleanup — scope by THIS spec's creditors (SENIOR/DROP only, never
  // the canonical admins), this spec's project ids, and the unique deposit
  // marker. Never a blanket delete by MAKSYM/KOSTYA id (would nuke seed rows).
  async function clearLedger() {
    await dbSvc.db
      .delete(pendingObligations)
      .where(inArray(pendingObligations.creditorUserId, TEST_OWN_USER_IDS))
    await dbSvc.db.delete(transactions).where(inArray(transactions.projectId, MY_PROJECT_IDS))
    await dbSvc.db.delete(transactions).where(eq(transactions.senderLabel, DEPOSIT_LABEL))
    // MED-1 (security-review PR #438): ADMIN_INCOME now claims the hash carried
    // by its explorer receipt, and the registry outlives the row by design —
    // sweep the orphans so re-runs are deterministic.
    await sweepOrphanConsumedTxHashes(dbSvc)
  }

  async function gateBalance(): Promise<number> {
    return computeCompanyAccountBalanceFromLedger(dbSvc.db)
  }

  // Obligation rows for a creditor, joined to their source-transaction type so a
  // test can tell a senior IOU from a drop IOU.
  async function obligationsFor(creditorId: string): Promise<
    {
      id: string
      amount: string
      debtorType: string
      status: string
      sourceType: string | null
    }[]
  > {
    const rows = await dbSvc.db
      .select({
        id: pendingObligations.id,
        amount: pendingObligations.amount,
        debtorType: pendingObligations.debtorType,
        status: pendingObligations.status,
        sourceType: transactions.type,
      })
      .from(pendingObligations)
      .leftJoin(transactions, eq(pendingObligations.sourceTransactionId, transactions.id))
      .where(eq(pendingObligations.creditorUserId, creditorId))
    return rows
  }

  async function txsOfType(
    type: string,
  ): Promise<{ amount: string; fundingSource: string | null }[]> {
    const rows = await dbSvc.db
      .select({ amount: transactions.amount, fundingSource: transactions.fundingSource })
      .from(transactions)
      .where(eq(transactions.type, type))
    return rows
  }

  // task-admin-income-drop-backfill AC1/AC2: fetch the obligation's own SOURCE
  // transaction row (the SENIOR_PENDING_PAYOUT / DROP_PENDING_PAYOUT IOU) so a
  // test can read `sourceIncomeTransactionId` off it.
  async function sourceTxOf(
    obligationId: string,
  ): Promise<typeof transactions.$inferSelect | undefined> {
    const obl = await dbSvc.db.query.pendingObligations.findFirst({
      where: eq(pendingObligations.id, obligationId),
    })
    if (!obl) return undefined
    return dbSvc.db.query.transactions.findFirst({
      where: eq(transactions.id, obl.sourceTransactionId),
    })
  }

  beforeAll(async () => {
    try {
      const probe = new Pool({ connectionString: process.env['DATABASE_URL'] })
      await probe.query('SELECT 1')
      const check = await probe.query(
        `SELECT 1 FROM pg_type WHERE typname='project_payment_type' LIMIT 1`,
      )
      await probe.end()
      if (check.rowCount === 0) {
        throw new Error('[usdt-income-obligations] FAILED — project_payment_type enum not found')
      }
    } catch {
      throw new Error('[usdt-income-obligations] FAILED — no DB reachable at DATABASE_URL')
    }

    const moduleRef = await Test.createTestingModule({ imports: [UsdtTestModule] }).compile()
    await moduleRef.init()
    svc = moduleRef.get(TransactionsService)
    settleSvc = moduleRef.get(PendingSettlementService)
    dbSvc = moduleRef.get(DatabaseService)

    const db = dbSvc.db
    await db
      .delete(projects)
      .where(
        inArray(projects.id, [
          USDT_DROP_PROJECT,
          USDT_SENIOR_PROJECT,
          FOP_DROP_PROJECT,
          USDT_OVERRIDE_PROJECT,
        ]),
      )
    await clearLedger()
    await db.delete(users).where(inArray(users.id, TEST_OWN_USER_IDS))
    await db
      .insert(users)
      .values(
        [...TEST_OWN_USERS, ADMIN_MAKSYM, ADMIN_KOSTYA].map((u) => ({
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

    // USDT drop-project: senior (non-admin) + drop bound, no override → 5%.
    // USDT senior-project: senior only, no drop.
    // FOP drop-project: for the declaration gate.
    // USDT override-project: project drop override 12%.
    await db
      .insert(projects)
      .values([
        {
          id: USDT_DROP_PROJECT,
          name: 'USDT Drop Project',
          companyName: 'USDT DropCorp',
          domain: 'fintech',
          startDate: new Date('2025-01-01'),
          seniorId: SENIOR.id,
          dropId: DROP.id,
          currency: 'USDT',
          rate: 1000,
          paymentType: 'USDT',
        },
        {
          id: USDT_SENIOR_PROJECT,
          name: 'USDT Senior Project',
          companyName: 'USDT SeniorCorp',
          domain: 'ai',
          startDate: new Date('2025-01-01'),
          seniorId: SENIOR.id,
          dropId: null,
          currency: 'USDT',
          rate: 1000,
          paymentType: 'USDT',
        },
        {
          id: FOP_DROP_PROJECT,
          name: 'FOP Drop Project',
          companyName: 'FOP DropCorp',
          domain: 'fintech',
          startDate: new Date('2025-01-01'),
          seniorId: SENIOR.id,
          dropId: DROP.id,
          currency: 'USDT',
          rate: 1000,
          paymentType: 'FOP',
        },
        {
          id: USDT_OVERRIDE_PROJECT,
          name: 'USDT Override Project',
          companyName: 'USDT OverrideCorp',
          domain: 'fintech',
          startDate: new Date('2025-01-01'),
          seniorId: SENIOR.id,
          dropId: DROP.id,
          currency: 'USDT',
          rate: 1000,
          paymentType: 'USDT',
          dropSharePercentOverride: DROP_OVERRIDE,
        },
      ])
      .onConflictDoNothing()

    // Company account with a positive USDT balance so company-funded settles pass
    // the balance gate. Seed a COMPANY_DEPOSIT PAID USDT credit.
    const existing = await db.query.companyAccount.findFirst()
    if (!existing) {
      await db.insert(companyAccount).values({ id: ACCOUNT_ID, walletAddress: WALLET })
    } else {
      await db.update(companyAccount).set({ walletAddress: WALLET })
    }
  })

  beforeEach(async () => {
    seniorInvoiceTriggers = 0
    await clearLedger()
    // Fund the pool with a big COMPANY_DEPOSIT so company-funded settles pass the
    // gate. Tagged with DEPOSIT_LABEL so cleanup targets only this row.
    await dbSvc.db.insert(transactions).values({
      type: 'COMPANY_DEPOSIT',
      status: 'PAID',
      amount: '100000',
      currency: 'USDT',
      senderLabel: DEPOSIT_LABEL,
      createdBy: MAKSYM_ID,
    })
  })

  afterAll(async () => {
    // Clean up ALL rows this spec created so we do not pollute the shared DB for
    // company-wide integration specs (income-compliance / admin-summary) that run
    // later in the same suite and read every project/receiver.
    if (dbSvc) {
      await clearLedger()
      await dbSvc.db
        .delete(projects)
        .where(
          inArray(projects.id, [
            USDT_DROP_PROJECT,
            USDT_SENIOR_PROJECT,
            FOP_DROP_PROJECT,
            USDT_OVERRIDE_PROJECT,
          ]),
        )
      await dbSvc.db.delete(users).where(inArray(users.id, TEST_OWN_USER_IDS))
    }
    if (_pool) await _pool.end()
  })

  // ── AC9: paymentType declaration gate ──────────────────────────────────────
  it('AC9: SENIOR/DROP cannot declare income on a USDT project (403); FOP project is OK', async () => {
    await expect(
      svc.createDropIncome({ projectId: USDT_DROP_PROJECT, amount: 500, currency: 'USDT' }, DROP),
    ).rejects.toThrow(/USDT-проекте/)
    await expect(
      svc.createSeniorIncome(
        { projectId: USDT_SENIOR_PROJECT, amount: 500, currency: 'USDT' },
        SENIOR,
      ),
    ).rejects.toThrow(/USDT-проекте/)

    // FOP project: DROP declares fine (returns the created income).
    // task-receipts-backend (review round 1): currency='USDT' now requires a
    // mandatory explorer-link receipt (defense-in-depth service check, MED-2).
    const created = await svc.createDropIncome(
      {
        projectId: FOP_DROP_PROJECT,
        amount: 500,
        currency: 'USDT',
        receiptExternalUrl: 'https://etherscan.io/tx/0xusdtincomeobligationsspecac9',
      },
      DROP,
    )
    expect(created.type).toBe('DROP_INCOME')
  })

  // ── AC10: declareUsdtProjectIncome RBAC + receiver routing ─────────────────
  it('AC10: only ADMIN may declare USDT income (ACCOUNTANT/SENIOR/DROP/JUNIOR → 403)', async () => {
    const body = {
      projectId: USDT_DROP_PROJECT,
      amount: 1000,
      receiverId: COMPANY_ACCOUNT_RECEIVER,
    }
    for (const nonAdmin of [ACCOUNTANT, SENIOR, DROP, JUNIOR]) {
      await expect(declare(body, nonAdmin)).rejects.toThrow()
    }
  })

  it('AC10: receiver=COMPANY_ACCOUNT → ADMIN_INCOME(COMPANY_ACCOUNT); non-USDT project rejected', async () => {
    const income = await declare(
      { projectId: USDT_DROP_PROJECT, amount: 1000, receiverId: COMPANY_ACCOUNT_RECEIVER },
      ADMIN_MAKSYM,
    )
    expect(income.type).toBe('ADMIN_INCOME')
    expect(income.status).toBe('PAID')
    const admins = await txsOfType('ADMIN_INCOME')
    expect(admins).toHaveLength(1)
    expect(admins[0]!.fundingSource).toBe('COMPANY_ACCOUNT')

    // A FOP project cannot receive an admin-USDT declaration.
    await expect(
      declare(
        { projectId: FOP_DROP_PROJECT, amount: 1000, receiverId: COMPANY_ACCOUNT_RECEIVER },
        ADMIN_MAKSYM,
      ),
    ).rejects.toThrow(/USDT-проекте/)
  })

  it('AC10: receiver=ADMIN X → ADMIN_INCOME(funding=null, receiverId=X)', async () => {
    const income = await declare(
      { projectId: USDT_DROP_PROJECT, amount: 1000, receiverId: KOSTYA_ID },
      ADMIN_MAKSYM,
    )
    expect(income.type).toBe('ADMIN_INCOME')
    const admins = await txsOfType('ADMIN_INCOME')
    expect(admins).toHaveLength(1)
    expect(admins[0]!.fundingSource).toBeNull()
  })

  // ── AC11: atomic obligations (senior IOU + drop IOU) ───────────────────────
  it('AC11: booking is atomic — senior IOU (I×26%) + drop IOU (I×5%) with pending_obligations', async () => {
    await declare(
      { projectId: USDT_DROP_PROJECT, amount: 1000, receiverId: COMPANY_ACCOUNT_RECEIVER },
      ADMIN_MAKSYM,
    )
    const seniorObls = await obligationsFor(SENIOR.id)
    const dropObls = await obligationsFor(DROP.id)
    expect(seniorObls).toHaveLength(1)
    expect(dropObls).toHaveLength(1)
    expect(seniorObls[0]!.sourceType).toBe('SENIOR_PENDING_PAYOUT')
    expect(dropObls[0]!.sourceType).toBe('DROP_PENDING_PAYOUT')
    expect(seniorObls[0]!.debtorType).toBe('COMPANY')
    expect(dropObls[0]!.debtorType).toBe('COMPANY')
    expect(parseFloat(seniorObls[0]!.amount)).toBeCloseTo((1000 * SENIOR_SHARE) / 100, 6)
    expect(parseFloat(dropObls[0]!.amount)).toBeCloseTo((1000 * DROP_SHARE) / 100, 6)
  })

  it('AC11: senior-only USDT project → senior IOU only, no drop IOU', async () => {
    await declare(
      { projectId: USDT_SENIOR_PROJECT, amount: 1000, receiverId: COMPANY_ACCOUNT_RECEIVER },
      ADMIN_MAKSYM,
    )
    expect(await obligationsFor(SENIOR.id)).toHaveLength(1)
    expect(await obligationsFor(DROP.id)).toHaveLength(0)
  })

  it('AC11: drop IOU uses the per-project override (12%, not the 5% user default)', async () => {
    await declare(
      { projectId: USDT_OVERRIDE_PROJECT, amount: 1000, receiverId: COMPANY_ACCOUNT_RECEIVER },
      ADMIN_MAKSYM,
    )
    const dropObls = await obligationsFor(DROP.id)
    expect(dropObls).toHaveLength(1)
    expect(parseFloat(dropObls[0]!.amount)).toBeCloseTo((1000 * DROP_OVERRIDE) / 100, 6)
  })

  // ── task-admin-income-drop-backfill AC1/AC2: sourceIncomeTransactionId ─────
  it('task-admin-income-drop-backfill AC1: booking stamps sourceIncomeTransactionId on BOTH the senior IOU and the drop IOU, equal to the ADMIN_INCOME row it was booked from', async () => {
    const income = await declare(
      { projectId: USDT_DROP_PROJECT, amount: 1000, receiverId: COMPANY_ACCOUNT_RECEIVER },
      ADMIN_MAKSYM,
    )
    const [seniorObl] = await obligationsFor(SENIOR.id)
    const [dropObl] = await obligationsFor(DROP.id)
    const seniorSrc = await sourceTxOf(seniorObl!.id)
    const dropSrc = await sourceTxOf(dropObl!.id)
    expect(seniorSrc!.sourceIncomeTransactionId).toBe(income.id)
    expect(dropSrc!.sourceIncomeTransactionId).toBe(income.id)
  })

  it('task-admin-income-drop-backfill AC2: the payout cascade (manualConfirmPayout → applyPayoutPaidCascade) books the drop IOU with sourceIncomeTransactionId=NULL — no single source income to name', async () => {
    const [income] = await dbSvc.db
      .insert(transactions)
      .values({
        type: 'DROP_INCOME',
        status: 'VALIDATED',
        amount: '1000',
        currency: 'USDT',
        receiverId: DROP.id,
        recipientId: DROP.id,
        projectId: USDT_DROP_PROJECT,
        dropSharePercent: DROP_SHARE,
        dropSharePercentSource: 'USER_DEFAULT',
        createdBy: DROP.id,
      })
      .returning()
    const pr = await svc.createPayoutRequest([income!.id], DROP)
    const hash = '0x' + 'bd'.repeat(32)
    await svc.manualConfirmPayout(pr.id, 'COMPANY_ACCOUNT', ADMIN_MAKSYM, { txHash: hash })

    const [dropObl] = await obligationsFor(DROP.id)
    expect(dropObl!.sourceType).toBe('DROP_PENDING_PAYOUT')
    const dropSrc = await sourceTxOf(dropObl!.id)
    expect(dropSrc!.payoutRequestId).toBe(pr.id)
    expect(dropSrc!.sourceIncomeTransactionId).toBeNull()
  })

  // ── AC12: idempotent settle (anti-BIZ-02 double-settle) ────────────────────
  it('AC12: double settle of one obligation → second call is rejected (no double payout)', async () => {
    await declare(
      { projectId: USDT_DROP_PROJECT, amount: 1000, receiverId: COMPANY_ACCOUNT_RECEIVER },
      ADMIN_MAKSYM,
    )
    const [dropObl] = await obligationsFor(DROP.id)
    await settle(dropObl!.id, ADMIN_MAKSYM, { fundingSource: 'COMPANY_ACCOUNT' })
    await expect(
      settle(dropObl!.id, ADMIN_MAKSYM, { fundingSource: 'COMPANY_ACCOUNT' }),
    ).rejects.toThrow(/закрыт/)
    // Exactly one PAYOUT_DROP settlement row.
    expect(await txsOfType('PAYOUT_DROP')).toHaveLength(1)
  })

  // ── AC13: settle drop → PAYOUT_DROP credits the drop, no senior invoice ────
  it('AC13: settling a drop IOU settles to PAYOUT_DROP (credits drop balance), no senior invoice', async () => {
    await declare(
      { projectId: USDT_DROP_PROJECT, amount: 1000, receiverId: COMPANY_ACCOUNT_RECEIVER },
      ADMIN_MAKSYM,
    )
    const before = (await svc.getDropSelfSummary(DROP)).balance
    const [dropObl] = await obligationsFor(DROP.id)
    const res = await settle(dropObl!.id, ADMIN_MAKSYM, {
      fundingSource: 'COMPANY_ACCOUNT',
    })
    expect(res.created.some((c) => c.type === 'PAYOUT_DROP')).toBe(true)
    expect(res.created.some((c) => c.type === 'SENIOR_INCOME')).toBe(false)
    expect(seniorInvoiceTriggers).toBe(0)
    const after = (await svc.getDropSelfSummary(DROP)).balance
    expect(after - before).toBeCloseTo((1000 * DROP_SHARE) / 100, 6)
  })

  it('AC13: settling a senior IOU settles to SENIOR_INCOME + fires the senior invoice', async () => {
    await declare(
      { projectId: USDT_DROP_PROJECT, amount: 1000, receiverId: COMPANY_ACCOUNT_RECEIVER },
      ADMIN_MAKSYM,
    )
    const [seniorObl] = await obligationsFor(SENIOR.id)
    const res = await settle(seniorObl!.id, ADMIN_MAKSYM, {
      fundingSource: 'COMPANY_ACCOUNT',
    })
    expect(res.created.some((c) => c.type === 'SENIOR_INCOME')).toBe(true)
    expect(seniorInvoiceTriggers).toBe(1)
  })

  // ── task-settle-in-place (ADR 2026-07-14): the fix ─────────────────────────
  // The obligation must transition PENDING_PAYMENT → PAID **in place** on the
  // SOURCE IOU row — NO second transaction, NO lingering «Ожидает выплаты»
  // phantom. The `created` settle row reuses the source id (self-reference), and
  // the closingTransactionId points at that same row.
  it('settle-in-place: senior IOU flips SENIOR_PENDING_PAYOUT → SENIOR_INCOME on the SAME row (no second tx)', async () => {
    await declare(
      { projectId: USDT_DROP_PROJECT, amount: 1000, receiverId: COMPANY_ACCOUNT_RECEIVER },
      ADMIN_MAKSYM,
    )
    const [seniorObl] = await obligationsFor(SENIOR.id)
    const srcId = (await dbSvc.db.query.pendingObligations.findFirst({
      where: eq(pendingObligations.id, seniorObl!.id),
    }))!.sourceTransactionId

    const before = await dbSvc.db.query.transactions.findFirst({
      where: eq(transactions.id, srcId),
    })
    expect(before!.type).toBe('SENIOR_PENDING_PAYOUT')
    expect(before!.status).toBe('PENDING_PAYMENT')
    // Booking stamped a share snapshot on the IOU (amount is already the net share).
    expect(before!.seniorSharePercent).not.toBeNull()

    const res = await settle(seniorObl!.id, ADMIN_MAKSYM, { fundingSource: 'COMPANY_ACCOUNT' })

    // Same row, flipped in place → SENIOR_INCOME / PAID.
    const after = await dbSvc.db.query.transactions.findFirst({
      where: eq(transactions.id, srcId),
    })
    expect(after!.type).toBe('SENIOR_INCOME')
    expect(after!.status).toBe('PAID')
    // MONEY-CRITICAL: the share snapshot is nulled so getSeniorBalance treats the
    // amount as NET (no ×26% re-application) — byte-identical to the old settle row.
    expect(after!.seniorSharePercent).toBeNull()
    // The settle response carries the flipped row — reusing the SOURCE id (proof
    // that NO second transaction was inserted).
    expect(res.created).toHaveLength(1)
    expect(res.created[0]!.id).toBe(srcId)
    expect(res.created[0]!.type).toBe('SENIOR_INCOME')
    // Obligation closed, pointing at itself (self-reference).
    const obl = await dbSvc.db.query.pendingObligations.findFirst({
      where: eq(pendingObligations.id, seniorObl!.id),
    })
    expect(obl!.status).toBe('PAID')
    expect(obl!.closingTransactionId).toBe(srcId)
    // The phantom is gone — no SENIOR_PENDING_PAYOUT remains for this senior.
    const seniorTxs = await dbSvc.db
      .select({ type: transactions.type })
      .from(transactions)
      .where(eq(transactions.receiverId, SENIOR.id))
    expect(seniorTxs.some((t) => t.type === 'SENIOR_PENDING_PAYOUT')).toBe(false)
  })

  it('settle-in-place: drop IOU flips DROP_PENDING_PAYOUT → PAYOUT_DROP on the SAME row (no second tx)', async () => {
    await declare(
      { projectId: USDT_DROP_PROJECT, amount: 1000, receiverId: COMPANY_ACCOUNT_RECEIVER },
      ADMIN_MAKSYM,
    )
    const [dropObl] = await obligationsFor(DROP.id)
    const srcId = (await dbSvc.db.query.pendingObligations.findFirst({
      where: eq(pendingObligations.id, dropObl!.id),
    }))!.sourceTransactionId

    const before = await dbSvc.db.query.transactions.findFirst({
      where: eq(transactions.id, srcId),
    })
    expect(before!.type).toBe('DROP_PENDING_PAYOUT')
    expect(before!.status).toBe('PENDING_PAYMENT')

    const res = await settle(dropObl!.id, ADMIN_MAKSYM, { fundingSource: 'COMPANY_ACCOUNT' })

    const after = await dbSvc.db.query.transactions.findFirst({
      where: eq(transactions.id, srcId),
    })
    expect(after!.type).toBe('PAYOUT_DROP')
    expect(after!.status).toBe('PAID')
    expect(res.created).toHaveLength(1)
    expect(res.created[0]!.id).toBe(srcId)
    expect(res.created[0]!.type).toBe('PAYOUT_DROP')
    const obl = await dbSvc.db.query.pendingObligations.findFirst({
      where: eq(pendingObligations.id, dropObl!.id),
    })
    expect(obl!.closingTransactionId).toBe(srcId)
    // No PAYOUT_DROP invoice (Q6) and the phantom DROP_PENDING_PAYOUT is gone.
    expect(seniorInvoiceTriggers).toBe(0)
    const dropTxs = await dbSvc.db
      .select({ type: transactions.type })
      .from(transactions)
      .where(eq(transactions.receiverId, DROP.id))
    expect(dropTxs.some((t) => t.type === 'DROP_PENDING_PAYOUT')).toBe(false)
  })

  // ── Defense-in-depth negative control (review round 1, code-review MED) ────
  // Real-DB proof (not just the mocked unit test) that the flip's OWN status
  // guard (`UPDATE transactions … WHERE id=sourceTx AND status='PENDING_PAYMENT'`)
  // is a genuine transactional backstop: we corrupt the source IOU's status OUT
  // OF BAND (bypassing settleByCompany entirely, as if some other process
  // mutated it) while the obligation stays PENDING — so the obligation-level
  // TOCTOU claim WOULD win. settleByCompany must still refuse, and — because
  // this is Postgres, not a mock — the whole `db.transaction` must ROLL BACK,
  // undoing the obligation claim too. We assert the obligation is STILL PENDING
  // afterward (not left half-closed with no closing row).
  it('settle-in-place defense-in-depth: source IOU status corrupted out of band aborts the WHOLE transaction (real rollback)', async () => {
    await declare(
      { projectId: USDT_DROP_PROJECT, amount: 1000, receiverId: COMPANY_ACCOUNT_RECEIVER },
      ADMIN_MAKSYM,
    )
    const [seniorObl] = await obligationsFor(SENIOR.id)
    const srcId = (await dbSvc.db.query.pendingObligations.findFirst({
      where: eq(pendingObligations.id, seniorObl!.id),
    }))!.sourceTransactionId

    // Corrupt the invariant directly (NOT via settleByCompany): the source IOU is
    // no longer PENDING_PAYMENT, but the obligation is untouched (still PENDING).
    await dbSvc.db
      .update(transactions)
      .set({ status: 'REJECTED' })
      .where(eq(transactions.id, srcId))

    await expect(
      settle(seniorObl!.id, ADMIN_MAKSYM, { fundingSource: 'COMPANY_ACCOUNT' }),
    ).rejects.toThrow(/не в статусе ожидания выплаты/)

    // The whole transaction rolled back — the obligation claim is UNDONE, not
    // left half-closed. If this were only a mock we could not observe this; on
    // real Postgres a throw inside db.transaction(cb) rolls back every write the
    // callback made, including the earlier conditional UPDATE.
    const obl = await dbSvc.db.query.pendingObligations.findFirst({
      where: eq(pendingObligations.id, seniorObl!.id),
    })
    expect(obl!.status).toBe('PENDING')
    expect(obl!.closingTransactionId).toBeNull()
    // The corrupted source row is untouched (no flip attempted/applied).
    const src = await dbSvc.db.query.transactions.findFirst({ where: eq(transactions.id, srcId) })
    expect(src!.status).toBe('REJECTED')
    expect(src!.type).toBe('SENIOR_PENDING_PAYOUT')
    // No invoice fired — the settle never actually completed.
    expect(seniorInvoiceTriggers).toBe(0)
  })

  // ── MED-1 (review round 1, ADR C9): RBAC visibility of the new IOU/settlement
  // types through assertReadAccess (findOne) + findAll's inline RBAC filter.
  // Neither DROP_PENDING_PAYOUT nor PAYOUT_DROP is blacklisted from the
  // sender/receiver-match rule (unlike PAYOUT_ADMIN/PAYOUT_CONFIRMED), so a
  // party (DROP/SENIOR) sees their OWN row; a non-party sees neither; ADMIN/
  // ACCOUNTANT see everything. Proven against the REAL cascade rows, not mocks.
  describe('MED-1: DROP_PENDING_PAYOUT / PAYOUT_DROP RBAC visibility (real DB)', () => {
    it('DROP sees their own DROP_PENDING_PAYOUT; SENIOR does NOT see it (findOne)', async () => {
      await declare(
        { projectId: USDT_DROP_PROJECT, amount: 1000, receiverId: COMPANY_ACCOUNT_RECEIVER },
        ADMIN_MAKSYM,
      )
      const [dropObl] = await obligationsFor(DROP.id)
      const dropPendingTxId = (
        await dbSvc.db.query.pendingObligations.findFirst({
          where: eq(pendingObligations.id, dropObl!.id),
        })
      )?.sourceTransactionId
      expect(dropPendingTxId).toBeTruthy()

      // DROP sees their own IOU.
      const seenByDrop = await svc.findOne(dropPendingTxId!, DROP)
      expect(seenByDrop.type).toBe('DROP_PENDING_PAYOUT')
      // SENIOR is neither sender nor receiver of the DROP's IOU → 403.
      await expect(svc.findOne(dropPendingTxId!, SENIOR)).rejects.toThrow()
      // ACCOUNTANT and ADMIN see everything (RBAC bypass for company-wide roles).
      await expect(svc.findOne(dropPendingTxId!, ACCOUNTANT)).resolves.not.toThrow()
      await expect(svc.findOne(dropPendingTxId!, ADMIN_MAKSYM)).resolves.not.toThrow()
      // JUNIOR is never a party to finance rows.
      await expect(svc.findOne(dropPendingTxId!, JUNIOR)).rejects.toThrow()
    })

    it('SENIOR sees their own SENIOR_PENDING_PAYOUT; DROP does NOT see it (findOne)', async () => {
      await declare(
        { projectId: USDT_DROP_PROJECT, amount: 1000, receiverId: COMPANY_ACCOUNT_RECEIVER },
        ADMIN_MAKSYM,
      )
      const [seniorObl] = await obligationsFor(SENIOR.id)
      const seniorPendingTxId = (
        await dbSvc.db.query.pendingObligations.findFirst({
          where: eq(pendingObligations.id, seniorObl!.id),
        })
      )?.sourceTransactionId
      expect(seniorPendingTxId).toBeTruthy()

      await expect(svc.findOne(seniorPendingTxId!, SENIOR)).resolves.not.toThrow()
      // DROP is neither sender nor receiver of the SENIOR's IOU → 403.
      await expect(svc.findOne(seniorPendingTxId!, DROP)).rejects.toThrow()
      await expect(svc.findOne(seniorPendingTxId!, ACCOUNTANT)).resolves.not.toThrow()
      await expect(svc.findOne(seniorPendingTxId!, ADMIN_MAKSYM)).resolves.not.toThrow()
    })

    it('after settle: DROP sees their own PAYOUT_DROP; SENIOR does NOT (findOne)', async () => {
      await declare(
        { projectId: USDT_DROP_PROJECT, amount: 1000, receiverId: COMPANY_ACCOUNT_RECEIVER },
        ADMIN_MAKSYM,
      )
      const [dropObl] = await obligationsFor(DROP.id)
      const res = await settle(dropObl!.id, ADMIN_MAKSYM, {
        fundingSource: 'COMPANY_ACCOUNT',
      })
      const payoutDropId = res.created.find((c) => c.type === 'PAYOUT_DROP')!.id

      await expect(svc.findOne(payoutDropId, DROP)).resolves.not.toThrow()
      await expect(svc.findOne(payoutDropId, SENIOR)).rejects.toThrow()
      await expect(svc.findOne(payoutDropId, ACCOUNTANT)).resolves.not.toThrow()
      await expect(svc.findOne(payoutDropId, ADMIN_MAKSYM)).resolves.not.toThrow()
    })

    it('findAll: DROP sees own DROP_PENDING_PAYOUT + PAYOUT_DROP; SENIOR list excludes them; ACCOUNTANT sees both', async () => {
      // task-settle-in-place: a settle FLIPS the drop IOU (DROP_PENDING_PAYOUT →
      // PAYOUT_DROP) in place, so a single declare+settle leaves NO lingering
      // DROP_PENDING_PAYOUT. To exercise BOTH types' RBAC visibility at once we
      // (a) declare + settle one drop IOU → PAYOUT_DROP, then (b) declare a SECOND
      // income WITHOUT settling → a fresh, still-PENDING DROP_PENDING_PAYOUT.
      await declare(
        { projectId: USDT_DROP_PROJECT, amount: 1000, receiverId: COMPANY_ACCOUNT_RECEIVER },
        ADMIN_MAKSYM,
      )
      const [dropObl] = await obligationsFor(DROP.id)
      await settle(dropObl!.id, ADMIN_MAKSYM, {
        fundingSource: 'COMPANY_ACCOUNT',
      })
      // Second (unsettled) declaration → a lingering DROP_PENDING_PAYOUT.
      await declare(
        { projectId: USDT_DROP_PROJECT, amount: 1000, receiverId: COMPANY_ACCOUNT_RECEIVER },
        ADMIN_MAKSYM,
      )

      const dropList = await svc.findAll(DROP)
      expect(dropList.some((t) => t.type === 'DROP_PENDING_PAYOUT')).toBe(true)
      expect(dropList.some((t) => t.type === 'PAYOUT_DROP')).toBe(true)

      const seniorList = await svc.findAll(SENIOR)
      expect(seniorList.some((t) => t.type === 'DROP_PENDING_PAYOUT')).toBe(false)
      expect(seniorList.some((t) => t.type === 'PAYOUT_DROP')).toBe(false)

      const accountantList = await svc.findAll(ACCOUNTANT)
      expect(accountantList.some((t) => t.type === 'DROP_PENDING_PAYOUT')).toBe(true)
      expect(accountantList.some((t) => t.type === 'PAYOUT_DROP')).toBe(true)
    })
  })

  // ── AC14: company-account ledger consistency ───────────────────────────────
  it('AC14: ledger — declare(pool) then settle drop from the pool subtracts the drop slice', async () => {
    const base = await gateBalance()
    await declare(
      { projectId: USDT_DROP_PROJECT, amount: 1000, receiverId: COMPANY_ACCOUNT_RECEIVER },
      ADMIN_MAKSYM,
    )
    // +1000 gross into the pool (ADMIN_INCOME COMPANY_ACCOUNT).
    expect(await gateBalance()).toBeCloseTo(base + 1000, 6)
    const [dropObl] = await obligationsFor(DROP.id)
    await settle(dropObl!.id, ADMIN_MAKSYM, { fundingSource: 'COMPANY_ACCOUNT' })
    // − drop slice (50) from the pool via the new PAYOUT_DROP(COMPANY_ACCOUNT) term.
    expect(await gateBalance()).toBeCloseTo(base + 1000 - (1000 * DROP_SHARE) / 100, 6)
  })

  // ── AC15: C4 — totalIncome counts the gross once ───────────────────────────
  it('AC15: receiver=ADMIN X → declare + settle senior ADMIN_PERSONAL → totalIncome not doubled', async () => {
    await declare(
      { projectId: USDT_DROP_PROJECT, amount: 1000, receiverId: KOSTYA_ID },
      ADMIN_MAKSYM,
    )
    const before = (await svc.getSummary(ADMIN_MAKSYM)).totalIncome
    const [seniorObl] = await obligationsFor(SENIOR.id)
    await settle(seniorObl!.id, ADMIN_MAKSYM, {
      fundingSource: 'ADMIN_PERSONAL',
      payerAdminId: KOSTYA_ID,
      currency: 'USDT',
    })
    const after = (await svc.getSummary(ADMIN_MAKSYM)).totalIncome
    // The ADMIN_PERSONAL settlement SENIOR_INCOME (funding=null) must NOT add to
    // totalIncome — its gross was already counted as the ADMIN_INCOME.
    expect(after).toBeCloseTo(before, 6)
  })

  // ── AC16: debtToCompany regression under a per-project override ─────────────
  it('AC16: createPayoutRequest is override-aware — debtToCompany = I×(1−override%)', async () => {
    // A VALIDATED DROP_INCOME on the override project carrying the 12% snapshot.
    // createPayoutRequest books a PENDING_PAYMENT PAYOUT (senderId=drop) whose
    // amount is the company-kept share I×(1 − dropShare%). debtToCompany reads
    // that PAYOUT — so a per-project override (12%, not the 5% user default) must
    // flow through to the company-kept share (regression: override does not break
    // the payout math).
    const [income] = await dbSvc.db
      .insert(transactions)
      .values({
        type: 'DROP_INCOME',
        status: 'VALIDATED',
        amount: '1000',
        currency: 'USDT',
        receiverId: DROP.id,
        recipientId: DROP.id,
        projectId: USDT_OVERRIDE_PROJECT,
        dropSharePercent: DROP_OVERRIDE,
        dropSharePercentSource: 'PROJECT',
        createdBy: DROP.id,
      })
      .returning()
    await svc.createPayoutRequest([income!.id], DROP)
    const summary = await svc.getDropSelfSummary(DROP)
    // debtToCompany = income × (1 − dropShare/100) = 1000 × (1 − 0.12) = 880.
    expect(summary.debtToCompany).toBeCloseTo(1000 * (1 - DROP_OVERRIDE / 100), 6)
  })

  // ── MED-1 (security-review PR #438): ADMIN_INCOME joins the hash registry ───
  // `computeCompanyAccountBalanceFromLedger` credits THREE terms —
  // COMPANY_DEPOSIT, PAYOUT(COMPANY_ACCOUNT) and ADMIN_INCOME(COMPANY_ACCOUNT).
  // Registering only the first two left the "one transfer settles one thing"
  // invariant non-global: the same on-chain transfer could be declared as admin
  // income AND settle a payout / credit a deposit.
  describe('MED-1: admin USDT income consumes its on-chain hash', () => {
    const REAL_HASH = '0x' + 'ad'.repeat(32)

    it('claims the hash carried by the explorer receipt (purpose=ADMIN_INCOME)', async () => {
      const income = await declare(
        {
          projectId: USDT_DROP_PROJECT,
          amount: 500,
          receiverId: COMPANY_ACCOUNT_RECEIVER,
          receiptExternalUrl: `https://etherscan.io/tx/${REAL_HASH}`,
        },
        ADMIN_MAKSYM,
      )
      expect(income.status).toBe('PAID')

      const rows = await dbSvc.db
        .select()
        .from(consumedTxHashes)
        .where(eq(consumedTxHashes.txHash, REAL_HASH))
      expect(rows.length).toBe(1)
      expect(rows[0]!.purpose).toBe('ADMIN_INCOME')
      expect(rows[0]!.referenceId).toBe(income.id)
      // The hash is also recorded on the ledger row itself (attribution).
      const row = await dbSvc.db.query.transactions.findFirst({
        where: eq(transactions.id, income.id),
      })
      expect(row?.txHash).toBe(REAL_HASH)
    })

    it('SECURITY: a hash spent as admin income cannot then settle a payout', async () => {
      await declare(
        {
          projectId: USDT_DROP_PROJECT,
          amount: 500,
          receiverId: COMPANY_ACCOUNT_RECEIVER,
          receiptExternalUrl: `https://etherscan.io/tx/${REAL_HASH}`,
        },
        ADMIN_MAKSYM,
      )

      // A payout owned by the DROP, settled manually with the SAME transfer.
      const [payoutIncome] = await dbSvc.db
        .insert(transactions)
        .values({
          type: 'DROP_INCOME',
          status: 'VALIDATED',
          amount: '1000',
          currency: 'USDT',
          receiverId: DROP.id,
          recipientId: DROP.id,
          projectId: USDT_DROP_PROJECT,
          dropSharePercent: 5,
          createdBy: DROP.id,
        })
        .returning()
      const pr = await svc.createPayoutRequest([payoutIncome!.id], DROP)

      await expect(
        svc.manualConfirmPayout(pr.id, 'COMPANY_ACCOUNT', ADMIN_MAKSYM, { txHash: REAL_HASH }),
      ).rejects.toThrowError(/уже использован/)

      const after = await dbSvc.db.query.payoutRequests.findFirst({
        where: eq(payoutRequests.id, pr.id),
      })
      expect(after?.status).toBe('PENDING')
    })

    // ── MED-D (round 3): the PERSONAL-declaration branch had NO coverage. ────
    // Every other test here declares to the company pool, so the branch where
    // the claim is deliberately skipped (round-3 change) was never exercised —
    // a regression there would have burned an unrelated transfer silently.
    it('a PERSONAL declaration (receiver = an ADMIN) does NOT claim the hash', async () => {
      const PERSONAL_HASH = '0x' + 'ae'.repeat(32)
      const income = await declare(
        {
          projectId: USDT_DROP_PROJECT,
          amount: 500,
          // Receiver is an ADMIN, not the company pool → fundingSource stays
          // null, the company balance is untouched, so the transfer (which went
          // to that admin's OWN wallet) must remain spendable by its real payer.
          receiverId: ADMIN_KOSTYA.id,
          receiptExternalUrl: `https://etherscan.io/tx/${PERSONAL_HASH}`,
        },
        ADMIN_MAKSYM,
      )
      expect(income.status).toBe('PAID')

      const row = await dbSvc.db.query.transactions.findFirst({
        where: eq(transactions.id, income.id),
      })
      expect(row?.fundingSource).toBeNull() // personal, not the pool
      // Attribution is still recorded…
      expect(row?.txHash).toBe(PERSONAL_HASH)
      // …but nothing is claimed.
      const rows = await dbSvc.db
        .select({ id: consumedTxHashes.id })
        .from(consumedTxHashes)
        .where(eq(consumedTxHashes.txHash, PERSONAL_HASH))
      expect(rows.length).toBe(0)
    })

    it('a personal declaration leaves the transfer usable by the payout path', async () => {
      const SHARED_HASH = '0x' + 'af'.repeat(32)
      await declare(
        {
          projectId: USDT_DROP_PROJECT,
          amount: 500,
          receiverId: ADMIN_KOSTYA.id,
          receiptExternalUrl: `https://etherscan.io/tx/${SHARED_HASH}`,
        },
        ADMIN_MAKSYM,
      )

      // The same hash may still settle a payout — no false «уже использован».
      const [payoutIncome] = await dbSvc.db
        .insert(transactions)
        .values({
          type: 'DROP_INCOME',
          status: 'VALIDATED',
          amount: '1000',
          currency: 'USDT',
          receiverId: DROP.id,
          recipientId: DROP.id,
          projectId: USDT_DROP_PROJECT,
          dropSharePercent: 5,
          createdBy: DROP.id,
        })
        .returning()
      const pr = await svc.createPayoutRequest([payoutIncome!.id], DROP)
      const confirmed = await svc.manualConfirmPayout(pr.id, 'COMPANY_ACCOUNT', ADMIN_MAKSYM, {
        txHash: SHARED_HASH,
      })
      expect(confirmed.status).toBe('PAID')
    })

    it('a receipt link WITHOUT a real hash claims nothing (legacy links keep working)', async () => {
      const income = await declare(
        {
          projectId: USDT_DROP_PROJECT,
          amount: 321,
          receiverId: COMPANY_ACCOUNT_RECEIVER,
          receiptExternalUrl: 'https://etherscan.io/tx/legacy-marker-no-hash',
        },
        ADMIN_MAKSYM,
      )
      expect(income.status).toBe('PAID')
      const row = await dbSvc.db.query.transactions.findFirst({
        where: eq(transactions.id, income.id),
      })
      expect(row?.txHash).toBeNull()
    })
  })
})
