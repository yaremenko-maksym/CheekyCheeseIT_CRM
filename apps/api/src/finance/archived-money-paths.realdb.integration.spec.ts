/**
 * task-archived-user-completeness — AC3 + AC4, the money side, REAL DB.
 *
 * THE LINE THIS FILE DEFENDS
 * --------------------------
 * Archival must stop a departed person from acquiring a right to money they
 * have not earned. It must NOT stop the company paying out money they already
 * earned — that is not a safeguard, it is non-payment. Both halves are asserted
 * here against real services and a real Postgres, because only half of them
 * being right is the failure mode that would actually cost money:
 *
 *   REFUSED — new entitlement, money-out to a departed ADMIN partner
 *     • CompanyAccountService.createDividend      (a discretionary profit
 *       distribution decided NOW; nothing about it was earned earlier)
 *     • TransactionsService.createAdminTransfer   (credits the RECEIVER, i.e.
 *       places more company money in a departed partner's hands)
 *
 *   ALLOWED — settlement of what the company already owes
 *     • bookCompanyObligations (reached through declareUsdtProjectIncome):
 *       records what the company owes a senior/drop for income it just booked.
 *       The senior earned it on work already delivered, so an ARCHIVED senior
 *       and an ARCHIVED drop must still get their IOUs. A guard phrased
 *       "refuse anything whose beneficiary is archived" would silently delete
 *       those debts — this is the single most expensive way to get this task
 *       wrong, so it is asserted first-class.
 *     • PendingSettlementService.settleByCompany — pays that IOU out.
 *     • createPayoutRequest + manualConfirmPayout — a departed senior's
 *       already-earned payout still completes.
 *
 * ON AC3 BEING UNREACHABLE TODAY. An archived ADMIN cannot be produced through
 * the API (createUser refuses role=ADMIN; changeRole and adminUpdateUser refuse
 * promotion INTO ADMIN and refuse touching another ADMIN's role; archive refuses
 * another ADMIN and the controller refuses self-archive). The fixtures below
 * therefore write `archived_at` straight into the row — the guard is a lock on a
 * door that does not exist yet, and a test that could only run through that
 * non-existent door would prove nothing about the day someone builds it.
 *
 * RUN (never crm_db; the globalSetup guard also demands Postgres major 16):
 *   DATABASE_URL=postgresql://crm_user:password@127.0.0.1:5432/crm_scratch_x \
 *     pnpm --filter @crm/api exec vitest run archived-money-paths.realdb.integration.spec
 */
import { Global, Module } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq, inArray } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { COMPANY_ACCOUNT_RECEIVER } from '@crm/shared'

import { DatabaseService } from '../database/database.service'
import { CompanyAccountService } from './company-account.service'
import { PendingSettlementService } from './pending-settlement.service'
import { TransactionsService } from './transactions.service'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'
import { sweepOrphanConsumedTxHashes } from './__test-helpers__/consumed-tx-hashes'
import type { EtherscanService } from './etherscan.service'
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
import { assertRealDbSchema, hasDatabaseUrl } from '../test/require-real-db'

// ── Stable id namespace am88- (archived money paths, backlog 88) ────────────
const ADMIN_A_ID = 'a1880000-0000-4000-aa00-000000000001'
const ADMIN_B_ID = 'a1880000-0000-4000-aa00-000000000002'
const SENIOR_ID = 'a1880000-0000-4000-aa00-000000000003'
const DROP_ID = 'a1880000-0000-4000-aa00-000000000004'
const PROJECT_ID = 'a1880000-0000-4000-dd00-000000000001'

const ALL_USER_IDS = [ADMIN_A_ID, ADMIN_B_ID, SENIOR_ID, DROP_ID] as const
const DEPOSIT_LABEL = 'am88-spec-deposit'

const SENIOR_SHARE = 26
const DROP_SHARE = 5

const ADMIN_A: SessionUser = {
  id: ADMIN_A_ID,
  email: 'am88-admin-a@test.spec',
  displayName: 'AM88 Admin A',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 0,
  legalFullName: null,
}
const SENIOR: SessionUser = {
  ...ADMIN_A,
  id: SENIOR_ID,
  email: 'am88-senior@test.spec',
  displayName: 'AM88 Senior',
  role: 'SENIOR',
  seniorSharePercent: SENIOR_SHARE,
}

const EXPLORER_RECEIPT = 'https://etherscan.io/tx/0xam88archivedmoneypathsspec'
const WALLET = '0xC0FFEE0000000000000000000000000000000f88'

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

const stubInvoices = {
  autoCreateForPayout: () => Promise.resolve(),
  autoCreateForSeniorPayout: () => Promise.resolve(),
  autoCreateForIncome: () => Promise.resolve(),
  autoCreateForSalary: () => Promise.resolve(),
} as never

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
          configurable: true,
        })
        Object.defineProperty(instance, 'onModuleDestroy', {
          value: () => Promise.resolve(),
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
          documentsService: {} as never,
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
        new PendingSettlementService(db, stubInvoices, fakeNbu as NbuCurrencyService),
      inject: [DatabaseService],
    },
  ],
})
class Am88Module {}

describe.skipIf(!hasDatabaseUrl())('archived user — money-out vs settlement (real DB)', () => {
  let txSvc: TransactionsService
  let accountSvc: CompanyAccountService
  let settleSvc: PendingSettlementService
  let dbSvc: DatabaseService

  async function archive(id: string): Promise<void> {
    // Direct write on purpose — see the AC3 note in the file docblock.
    await dbSvc.db
      .update(users)
      .set({ archivedAt: new Date('2026-02-28T00:00:00.000Z') })
      .where(eq(users.id, id))
  }

  async function wipe(): Promise<void> {
    const db = dbSvc.db
    await db
      .delete(pendingObligations)
      .where(inArray(pendingObligations.creditorUserId, [...ALL_USER_IDS]))
    await db.delete(payoutRequests).where(inArray(payoutRequests.seniorId, [...ALL_USER_IDS]))
    await db.delete(transactions).where(eq(transactions.projectId, PROJECT_ID))
    await db.delete(transactions).where(inArray(transactions.createdBy, [...ALL_USER_IDS]))
    await db.delete(transactions).where(eq(transactions.senderLabel, DEPOSIT_LABEL))
    await sweepOrphanConsumedTxHashes(dbSvc)
    await db.delete(projects).where(eq(projects.id, PROJECT_ID))
    await db.delete(users).where(inArray(users.id, [...ALL_USER_IDS]))
  }

  function declareIncome(amount: number) {
    return txSvc.declareUsdtProjectIncome(
      {
        projectId: PROJECT_ID,
        amount,
        receiverId: COMPANY_ACCOUNT_RECEIVER,
        receiptExternalUrl: `${EXPLORER_RECEIPT}${randomUUID().replace(/-/g, '')}`,
        idempotencyKey: randomUUID(),
      },
      ADMIN_A,
    )
  }

  async function obligationsOf(creditorId: string) {
    return dbSvc.db
      .select({
        id: pendingObligations.id,
        amount: pendingObligations.amount,
        status: pendingObligations.status,
      })
      .from(pendingObligations)
      .where(eq(pendingObligations.creditorUserId, creditorId))
  }

  beforeAll(async () => {
    await assertRealDbSchema([
      { table: 'users', column: 'archived_at' },
      { table: 'pending_obligations', column: 'creditor_user_id' },
      { table: 'projects', column: 'payment_type' },
    ])

    const moduleRef = await Test.createTestingModule({ imports: [Am88Module] }).compile()
    await moduleRef.init()
    txSvc = moduleRef.get(TransactionsService)
    accountSvc = moduleRef.get(CompanyAccountService)
    settleSvc = moduleRef.get(PendingSettlementService)
    dbSvc = moduleRef.get(DatabaseService)
  })

  beforeEach(async () => {
    await wipe()
    const db = dbSvc.db
    await db.insert(users).values([
      {
        id: ADMIN_A_ID,
        email: 'am88-admin-a@test.spec',
        displayName: 'AM88 Admin A',
        role: 'ADMIN',
        googleId: `g-${ADMIN_A_ID}`,
      },
      {
        id: ADMIN_B_ID,
        email: 'am88-admin-b@test.spec',
        displayName: 'AM88 Admin B',
        role: 'ADMIN',
        googleId: `g-${ADMIN_B_ID}`,
      },
      {
        id: SENIOR_ID,
        email: 'am88-senior@test.spec',
        displayName: 'AM88 Senior',
        role: 'SENIOR',
        seniorSharePercent: SENIOR_SHARE,
        googleId: `g-${SENIOR_ID}`,
      },
      {
        id: DROP_ID,
        email: 'am88-drop@test.spec',
        displayName: 'AM88 Drop',
        role: 'DROP',
        dropSharePercent: DROP_SHARE,
        googleId: `g-${DROP_ID}`,
      },
    ])
    await db.insert(projects).values({
      id: PROJECT_ID,
      name: 'AM88 Project',
      companyName: 'AM88 Corp',
      domain: 'fintech',
      startDate: new Date('2025-01-01'),
      seniorId: SENIOR_ID,
      dropId: DROP_ID,
      currency: 'USDT',
      rate: 1000,
      paymentType: 'USDT',
    })

    // A company account with a funded ledger — settles and dividends both read it.
    const existingAccount = await db.query.companyAccount.findFirst()
    if (existingAccount) {
      await db.update(companyAccount).set({ walletAddress: WALLET })
    } else {
      await db.insert(companyAccount).values({ walletAddress: WALLET })
    }
    await db.insert(transactions).values({
      type: 'COMPANY_DEPOSIT',
      status: 'PAID',
      amount: '100000',
      currency: 'USDT',
      senderLabel: DEPOSIT_LABEL,
      createdBy: ADMIN_A_ID,
    })
  })

  afterAll(async () => {
    if (dbSvc) await wipe()
    if (_pool) await _pool.end()
  })

  // ── AC3 — money-out to a departed ADMIN partner ──────────────────────────
  describe('AC3 — new entitlement for an archived ADMIN is refused', () => {
    it('createDividend refuses an archived receiver, and books nothing', async () => {
      await archive(ADMIN_B_ID)
      const before = await dbSvc.db
        .select({ id: transactions.id })
        .from(transactions)
        .where(eq(transactions.type, 'DIVIDEND_TO_ADMIN'))

      await expect(
        accountSvc.createDividend(
          {
            amount: 100,
            adminId: ADMIN_B_ID,
            idempotencyKey: randomUUID(),
            receiptExternalUrl: `${EXPLORER_RECEIPT}div`,
          },
          ADMIN_A,
        ),
      ).rejects.toThrow(/архивирован/)

      const after = await dbSvc.db
        .select({ id: transactions.id })
        .from(transactions)
        .where(eq(transactions.type, 'DIVIDEND_TO_ADMIN'))
      expect(after.length).toBe(before.length)
    })

    it('CONTROL: the same dividend to an ACTIVE admin partner goes through', async () => {
      const created = await accountSvc.createDividend(
        {
          amount: 100,
          adminId: ADMIN_B_ID,
          idempotencyKey: randomUUID(),
          receiptExternalUrl: `${EXPLORER_RECEIPT}divok`,
        },
        ADMIN_A,
      )
      expect(created.receiverId).toBe(ADMIN_B_ID)
    })

    it('createAdminTransfer refuses an archived RECEIVER', async () => {
      await archive(ADMIN_B_ID)
      await expect(
        txSvc.createAdminTransfer(
          { receiverId: ADMIN_B_ID, amount: 50, receiptExternalUrl: `${EXPLORER_RECEIPT}tr` },
          ADMIN_A,
        ),
      ).rejects.toThrow(/архивирован/)
    })

    it('CONTROL: an archived SENDER may still hand money back', async () => {
      // The asymmetry is deliberate: the sender side of a transfer is a
      // departed partner returning what they still hold — the settlement half.
      // Only the RECEIVER side places NEW company money with someone who has
      // left. Booked by an ACCOUNTANT, the one caller allowed to name a sender.
      await archive(ADMIN_A_ID)
      const accountant: SessionUser = { ...ADMIN_A, role: 'ACCOUNTANT', id: SENIOR_ID }
      await dbSvc.db.update(users).set({ role: 'ACCOUNTANT' }).where(eq(users.id, SENIOR_ID))

      const created = await txSvc.createAdminTransfer(
        {
          senderId: ADMIN_A_ID,
          receiverId: ADMIN_B_ID,
          amount: 50,
          receiptExternalUrl: `${EXPLORER_RECEIPT}trback`,
        },
        accountant,
      )
      expect(created.type).toBe('ADMIN_TRANSFER')
    })
  })

  // ── AC4 — the settlement half must keep working ──────────────────────────
  describe('settlement paths are NOT affected by archival', () => {
    it('bookCompanyObligations still books IOUs for an ARCHIVED senior and drop', async () => {
      // The company just booked income on work these two already delivered.
      // Their debt exists regardless of whether they still work here — this is
      // exactly the case a "refuse anything to an archived beneficiary" guard
      // would have destroyed.
      await archive(SENIOR_ID)
      await archive(DROP_ID)

      await declareIncome(1000)

      const seniorIous = await obligationsOf(SENIOR_ID)
      const dropIous = await obligationsOf(DROP_ID)
      expect(seniorIous).toHaveLength(1)
      expect(dropIous).toHaveLength(1)
      expect(Number(seniorIous[0]!.amount)).toBeCloseTo(1000 * (SENIOR_SHARE / 100), 2)
      expect(Number(dropIous[0]!.amount)).toBeCloseTo(1000 * (DROP_SHARE / 100), 2)
    })

    it('settleByCompany still pays an ARCHIVED senior what the company owes', async () => {
      await declareIncome(1000)
      const [iou] = await obligationsOf(SENIOR_ID)
      expect(iou).toBeDefined()

      await archive(SENIOR_ID)

      await settleSvc.settleByCompany(iou!.id, ADMIN_A, {
        fundingSource: 'COMPANY_ACCOUNT',
        receiptExternalUrl: `${EXPLORER_RECEIPT}settle`,
      })

      const [after] = await obligationsOf(SENIOR_ID)
      expect(after!.status).toBe('PAID')
    })

    it('a departed senior’s payout request still completes (createPayoutRequest → manualConfirmPayout)', async () => {
      const [income] = await dbSvc.db
        .insert(transactions)
        .values({
          type: 'SENIOR_INCOME',
          status: 'VALIDATED',
          amount: '1000',
          currency: 'USDT',
          receiverId: SENIOR_ID,
          seniorSharePercent: SENIOR_SHARE,
          createdBy: SENIOR_ID,
        })
        .returning()
      const request = await txSvc.createPayoutRequest([income!.id], SENIOR)

      // Dismissed AFTER earning it — the money is still owed.
      await archive(SENIOR_ID)

      await txSvc.manualConfirmPayout(request.id, 'CASH', ADMIN_A)

      const stored = await dbSvc.db.query.payoutRequests.findFirst({
        where: eq(payoutRequests.id, request.id),
      })
      expect(stored?.status).toBe('PAID')
    })
  })
})
