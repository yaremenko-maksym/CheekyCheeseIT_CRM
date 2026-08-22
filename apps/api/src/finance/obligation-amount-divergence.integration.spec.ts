import { Global, Module } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq, inArray } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { MAKSYM_ID, COMPANY_ACCOUNT_RECEIVER } from '@crm/shared'

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
  pendingObligations,
  projects,
  transactions,
  users,
} from '../database/schema'
import * as schema from '../database/schema'
import { hasDatabaseUrl } from '../test/require-real-db'

/**
 * task-fix-obligation-amount-divergence (backlog 181, L3 in
 * docs/architecture/2026-08-22-paid-transaction-edit-cascade.md).
 *
 * L3, the live defect this closes: `pending_obligations.amount` is a SEPARATE
 * stored copy of the exact same number as the source IOU's `transactions.amount`
 * — bookCompanyObligations inserts both with the identical share at booking
 * time. Nothing kept them in sync afterwards. The settle-time money gate reads
 * FROM `obligation.amount` (PendingSettlementService.settleByCompany) while the
 * company-account ledger debits BY `transactions.amount` once the row flips to
 * PAID (computeCompanyAccountBalanceFromLedger, SENIOR_INCOME/PAYOUT_DROP
 * terms) — so a `adminUpdateTransaction` that touched only the transactions
 * copy let the gate check solvency against a stale sum while the ledger would
 * debit a DIFFERENT one.
 *
 * This is exactly the "checked one side, proved half, looked like the whole"
 * class the project has been burned by before (backlog 170) — so the test
 * below asserts BOTH directions of the symmetric invariant:
 *   1. after the edit, `transactions.amount === pending_obligations.amount`
 *      (the two stored copies agree), and
 *   2. the money gate and the ledger act on that SAME number — proven by an
 *      INSUFFICIENT-funds rejection that only fires if the gate reads the
 *      EDITED amount (not the stale pre-edit one), and by a successful settle
 *      whose ledger debit exactly matches the edited amount.
 *
 * Scope: only the still-`PENDING` obligation (AC3) — a CLOSED obligation's
 * amount is a historical record of a settlement that already happened (L4 in
 * the same doc) and is out of scope here.
 *
 * Proven against the REAL services + REAL DB (crm_qa), NOT mocked
 * (feedback_mocked_e2e_guards — a mocked gate would trivially "pass" without
 * ever exercising the two independent SQL reads this bug lives between).
 *
 * Run against a scratch DB (NEVER the live crm_db):
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_qa \
 *     pnpm --filter @crm/api test -- obligation-amount-divergence.integration
 */

const SENIOR: SessionUser = {
  id: 'ce460000-0000-4000-bb00-000000000001',
  email: 'obligation-divergence-senior@test.spec',
  displayName: 'Divergence Senior',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}
const ADMIN_MAKSYM: SessionUser = {
  ...SENIOR,
  id: MAKSYM_ID,
  email: 'obligation-divergence-maksym@test.spec',
  displayName: 'Divergence Maksym',
  role: 'ADMIN',
  seniorSharePercent: 0,
}

const TEST_OWN_USER_IDS = [SENIOR.id]

const ACCOUNT_ID = 'ce460000-0000-4000-cc00-000000000001'
const PROJECT_ID = 'ce460000-0000-4000-dd00-000000000001'
const DEPOSIT_LABEL = 'obligation-divergence-spec-deposit'
const SENIOR_SHARE = 26
const WALLET = '0xC0FFEE0000000000000000000000000000000def'

const fakeNbu: Pick<NbuCurrencyService, 'getRates'> = {
  getRates: () =>
    Promise.resolve({ usdUah: '40.0000', usdtUah: '40.0000', eurUah: '44.0000', date: '20260822' }),
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
class DivergenceTestModule {}

describe.skipIf(!hasDatabaseUrl())(
  'L3 fix — admin edit of an OPEN obligation keeps both amount copies in sync (real DB)',
  () => {
    let svc: TransactionsService
    let settleSvc: PendingSettlementService
    let dbSvc: DatabaseService

    function declare(amount: number) {
      return svc.declareUsdtProjectIncome(
        {
          projectId: PROJECT_ID,
          amount,
          receiverId: COMPANY_ACCOUNT_RECEIVER,
          idempotencyKey: randomUUID(),
          receiptExternalUrl: 'https://etherscan.io/tx/0xobligationdivergencespec',
        },
        ADMIN_MAKSYM,
      )
    }

    async function gateBalance(): Promise<number> {
      return computeCompanyAccountBalanceFromLedger(dbSvc.db)
    }

    // The senior obligation + its source IOU row (SENIOR_PENDING_PAYOUT),
    // freshly booked by the declare() above — there is exactly one at a time
    // because clearLedger() runs in beforeEach.
    async function seniorObligationAndSource() {
      const obligation = await dbSvc.db.query.pendingObligations.findFirst({
        where: eq(pendingObligations.creditorUserId, SENIOR.id),
      })
      if (!obligation) throw new Error('no senior obligation booked')
      const source = await dbSvc.db.query.transactions.findFirst({
        where: eq(transactions.id, obligation.sourceTransactionId),
      })
      if (!source) throw new Error('no source IOU row for the obligation')
      return { obligation, source }
    }

    async function clearLedger() {
      await dbSvc.db
        .delete(pendingObligations)
        .where(inArray(pendingObligations.creditorUserId, TEST_OWN_USER_IDS))
      await dbSvc.db.delete(transactions).where(eq(transactions.projectId, PROJECT_ID))
      await dbSvc.db.delete(transactions).where(eq(transactions.senderLabel, DEPOSIT_LABEL))
      await sweepOrphanConsumedTxHashes(dbSvc)
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
          throw new Error('[obligation-amount-divergence] FAILED — schema not migrated')
        }
      } catch {
        throw new Error('[obligation-amount-divergence] FAILED — no DB reachable at DATABASE_URL')
      }

      const moduleRef = await Test.createTestingModule({
        imports: [DivergenceTestModule],
      }).compile()
      await moduleRef.init()
      svc = moduleRef.get(TransactionsService)
      settleSvc = moduleRef.get(PendingSettlementService)
      dbSvc = moduleRef.get(DatabaseService)

      const db = dbSvc.db
      await db.delete(projects).where(eq(projects.id, PROJECT_ID))
      await clearLedger()
      await db.delete(users).where(inArray(users.id, TEST_OWN_USER_IDS))
      // ADMIN_MAKSYM uses the canonical MAKSYM_ID — present as seed data on a
      // shared crm_qa, but NOT on a throwaway scratch DB (this spec's own
      // Postgres instance, spun up specifically to dodge the native-Homebrew
      // vs docker-compose port-5432 collision — see live-db-access.md).
      // Insert it ourselves so `createdBy: MAKSYM_ID` FKs resolve either way.
      await db
        .insert(users)
        .values([
          {
            id: SENIOR.id,
            email: SENIOR.email,
            displayName: SENIOR.displayName,
            role: SENIOR.role,
            seniorSharePercent: SENIOR.seniorSharePercent,
            googleId: `test-google-${SENIOR.id}`,
          },
          {
            id: ADMIN_MAKSYM.id,
            email: ADMIN_MAKSYM.email,
            displayName: ADMIN_MAKSYM.displayName,
            role: ADMIN_MAKSYM.role,
            seniorSharePercent: ADMIN_MAKSYM.seniorSharePercent,
            googleId: `test-google-${ADMIN_MAKSYM.id}`,
          },
        ])
        .onConflictDoNothing()
      await db
        .insert(projects)
        .values({
          id: PROJECT_ID,
          name: 'Obligation Divergence Project',
          companyName: 'Divergence Co',
          domain: 'fintech',
          startDate: new Date('2025-01-01'),
          seniorId: SENIOR.id,
          dropId: null,
          currency: 'USDT',
          rate: 1000,
          paymentType: 'USDT',
        })
        .onConflictDoNothing()

      const existing = await db.query.companyAccount.findFirst()
      if (!existing) {
        await db.insert(companyAccount).values({ id: ACCOUNT_ID, walletAddress: WALLET })
      } else {
        await db.update(companyAccount).set({ walletAddress: WALLET })
      }
    })

    beforeEach(async () => {
      await clearLedger()
      // Fund the pool generously so the POSITIVE-path settle always clears —
      // the negative-path test deliberately edits the amount to exceed the
      // CURRENT balance instead of relying on this seed being "small".
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
      if (dbSvc) {
        await clearLedger()
        await dbSvc.db.delete(projects).where(eq(projects.id, PROJECT_ID))
        await dbSvc.db.delete(users).where(inArray(users.id, TEST_OWN_USER_IDS))
      }
      if (_pool) await _pool.end()
    })

    // ── AC1 sanity — the booked pair starts out equal (both copies, same value) ──
    it('booking writes the SAME share into both copies (transactions.amount === pending_obligations.amount)', async () => {
      await declare(1000)
      const { obligation, source } = await seniorObligationAndSource()
      expect(source.type).toBe('SENIOR_PENDING_PAYOUT')
      expect(source.status).toBe('PENDING_PAYMENT')
      expect(source.payoutRequestId).toBeNull()
      expect(parseFloat(source.amount)).toBeCloseTo((1000 * SENIOR_SHARE) / 100, 6)
      expect(source.amount).toBe(obligation.amount)
    })

    // ── AC2 — the fix: an admin edit of the OPEN IOU keeps both copies equal ────
    it('adminUpdateTransaction on the open IOU updates BOTH copies atomically — direction 1: equality', async () => {
      await declare(1000)
      const { source: before } = await seniorObligationAndSource()
      // None of the three edit guards hold this row today (AC1 of the task):
      // not a PAYOUT-family type, no payoutRequestId, and status is
      // PENDING_PAYMENT (not PAID) so BIZ-18 never fires.
      await svc.adminUpdateTransaction(before.id, { amount: 777 }, ADMIN_MAKSYM)

      const { obligation: obligationAfter, source: sourceAfter } = await seniorObligationAndSource()
      expect(sourceAfter.amount).toBe('777.000000')
      // Direction 1 of the symmetric invariant: BOTH stored copies agree —
      // not just "the one this reviewer happened to check".
      expect(obligationAfter.amount).toBe(sourceAfter.amount)
      expect(obligationAfter.status).toBe('PENDING')
    })

    // ── AC5, direction 2a — the money gate now reads the SAME (edited) amount
    // the ledger would debit: an edit that pushes the amount above the CURRENT
    // balance must be rejected at settle time, not silently accepted against a
    // stale, smaller `pending_obligations.amount`.
    it('direction 2 (insufficiency): settle rejects when the EDITED amount exceeds the balance — proves the gate reads the synced copy, not the stale one', async () => {
      const base = await gateBalance()
      await declare(1000) // +1000 gross into the pool; IOU/obligation booked at 260.
      const afterDeclare = await gateBalance()
      expect(afterDeclare).toBeCloseTo(base + 1000, 6)

      const { source: before } = await seniorObligationAndSource()
      expect(parseFloat(before.amount)).toBeCloseTo(260, 6) // 1000 × 26%, well under afterDeclare.

      // Edit the OPEN obligation's IOU to something the pool cannot cover.
      // Pre-fix, `pending_obligations.amount` would stay at 260 — comfortably
      // under the balance — and the gate would (wrongly) let the settle
      // through, only for the ledger to later debit the EDITED amount off the
      // flipped row and drive the balance negative.
      const tooMuch = afterDeclare + 5000
      await svc.adminUpdateTransaction(before.id, { amount: tooMuch }, ADMIN_MAKSYM)

      const { obligation: obligationAfter } = await seniorObligationAndSource()
      expect(obligationAfter.amount).toBe(String(tooMuch.toFixed(6)))

      await expect(
        settleSvc.settleByCompany(obligationAfter.id, ADMIN_MAKSYM, {
          fundingSource: 'COMPANY_ACCOUNT',
          receiptExternalUrl: 'https://etherscan.io/tx/0xobligationdivergencespec',
        }),
      ).rejects.toThrow(/Недостаточно средств/)

      // No partial debit — the rejected settle changed nothing on the ledger.
      expect(await gateBalance()).toBeCloseTo(afterDeclare, 6)
      const { obligation: stillOpen } = await seniorObligationAndSource()
      expect(stillOpen.status).toBe('PENDING')
    })

    // ── AC5, direction 2b — a settle that DOES clear the gate debits the
    // ledger by the EXACT edited amount, not the original pre-edit share.
    it('direction 2 (consistency): a settle that passes the gate debits the ledger by the EDITED amount, not the original share', async () => {
      const base = await gateBalance()
      await declare(1000) // IOU/obligation booked at 260.
      const { source: before } = await seniorObligationAndSource()
      expect(parseFloat(before.amount)).toBeCloseTo(260, 6)

      // Edit up to 555 — still well inside the 100000 deposit seeded above.
      await svc.adminUpdateTransaction(before.id, { amount: 555 }, ADMIN_MAKSYM)
      const { obligation } = await seniorObligationAndSource()
      expect(obligation.amount).toBe('555.000000')

      const beforeSettle = await gateBalance()
      const res = await settleSvc.settleByCompany(obligation.id, ADMIN_MAKSYM, {
        fundingSource: 'COMPANY_ACCOUNT',
        receiptExternalUrl: 'https://etherscan.io/tx/0xobligationdivergencespec',
      })
      expect(res.created).toHaveLength(1)
      expect(res.created[0]!.type).toBe('SENIOR_INCOME')

      // The ledger term for SENIOR_INCOME(COMPANY_ACCOUNT) reads `transactions.amount`
      // on the flipped row — which the settle flip leaves untouched, so it is
      // whatever adminUpdateTransaction last wrote (555), never the original 260.
      const afterSettle = await gateBalance()
      expect(afterSettle).toBeCloseTo(beforeSettle - 555, 6)
      expect(afterSettle).toBeCloseTo(base + 1000 - 555, 6)

      const flipped = await dbSvc.db.query.transactions.findFirst({
        where: eq(transactions.id, obligation.sourceTransactionId),
      })
      expect(flipped!.amount).toBe('555.000000')
    })

    // ── AC3 — a CLOSED obligation is untouched by this fix (out of scope). ──────
    it('AC3: a settled (PAID) obligation is left alone — amountChanged sync is scoped to status=PENDING', async () => {
      await declare(1000)
      const { obligation } = await seniorObligationAndSource()
      await settleSvc.settleByCompany(obligation.id, ADMIN_MAKSYM, {
        fundingSource: 'COMPANY_ACCOUNT',
        receiptExternalUrl: 'https://etherscan.io/tx/0xobligationdivergencespec',
      })
      const closed = await dbSvc.db.query.pendingObligations.findFirst({
        where: eq(pendingObligations.id, obligation.id),
      })
      expect(closed!.status).toBe('PAID')
      const closedAmountBefore = closed!.amount

      // The flipped row is now SENIOR_INCOME / PAID — BIZ-18 blocks money-field
      // edits on it outright (this task does not touch that guard).
      await expect(
        svc.adminUpdateTransaction(closed!.sourceTransactionId, { amount: 42 }, ADMIN_MAKSYM),
      ).rejects.toThrow()

      const stillClosed = await dbSvc.db.query.pendingObligations.findFirst({
        where: eq(pendingObligations.id, obligation.id),
      })
      expect(stillClosed!.amount).toBe(closedAmountBefore)
      expect(stillClosed!.status).toBe('PAID')
    })
  },
)
