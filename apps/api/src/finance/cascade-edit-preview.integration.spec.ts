import { Global, Module } from '@nestjs/common'
import { ForbiddenException, NotFoundException } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq, inArray, sql } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { MAKSYM_ID, COMPANY_ACCOUNT_RECEIVER } from '@crm/shared'

import { DatabaseService } from '../database/database.service'
import { PendingSettlementService } from './pending-settlement.service'
import { TransactionsService } from './transactions.service'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'
import { sweepOrphanConsumedTxHashes } from './__test-helpers__/consumed-tx-hashes'
import type { EtherscanService } from './etherscan.service'
import type { NbuCurrencyService } from './nbu-currency.service'
import {
  companyAccount,
  invoiceSignatures,
  payoutRequests,
  pendingObligations,
  projects,
  transactionAuditLog,
  transactions,
  users,
} from '../database/schema'
import * as schema from '../database/schema'
import { assertRealDbSchema, hasDatabaseUrl } from '../test/require-real-db'

/**
 * task-cascade-resolver-preview (task 2 of the paid-transaction-edit-cascade
 * decomposition — docs/architecture/2026-08-22-paid-transaction-edit-cascade.md).
 *
 * `resolveEditCascade` itself is exhaustively unit-tested in isolation
 * (packages/shared/src/schemas/edit-cascade.spec.ts, AC1/AC6/AC7) — this spec
 * does NOT re-run every arithmetic branch. Its job is the WIRING:
 * `loadCascadeSnapshot` reading REAL rows (source, derivatives, obligations,
 * the settled_* snapshot columns from task 1, invoice_signatures) off a REAL
 * DB and handing them to the resolver unmodified (AC8), and proving the
 * endpoint writes NOTHING regardless of outcome (AC9).
 *
 * Run against a scratch DB (NEVER the live crm_db):
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_qa \
 *     pnpm --filter @crm/api test -- cascade-edit-preview.integration
 */

const SENIOR: SessionUser = {
  id: 'ce7ad000-0000-4000-bb00-000000000001',
  email: 'cascade-preview-senior@test.spec',
  displayName: 'Cascade Preview Senior',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}
const DROP: SessionUser = {
  ...SENIOR,
  id: 'ce7ad000-0000-4000-bb00-000000000002',
  email: 'cascade-preview-drop@test.spec',
  displayName: 'Cascade Preview Drop',
  role: 'DROP',
}
const ADMIN_MAKSYM: SessionUser = {
  ...SENIOR,
  id: MAKSYM_ID,
  email: 'cascade-preview-maksym@test.spec',
  displayName: 'Cascade Preview Maksym',
  role: 'ADMIN',
  seniorSharePercent: 0,
}

const TEST_OWN_USER_IDS = [SENIOR.id, DROP.id]

const PROJECT_ID = 'ce7ad000-0000-4000-dd00-000000000001'
const DEPOSIT_LABEL = 'cascade-preview-spec-deposit'
const SENIOR_SHARE = 26
const DROP_SHARE = 5
const WALLET = '0xC0FFEE0000000000000000000000000000000def'
const ACCOUNT_ID = 'ce7ad000-0000-4000-cc00-000000000001'

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
      provide: PendingSettlementService,
      useFactory: (db: DatabaseService) =>
        new PendingSettlementService(db, stubInvoices as never, fakeNbu as NbuCurrencyService),
      inject: [DatabaseService],
    },
  ],
})
class CascadePreviewTestModule {}

describe.skipIf(!hasDatabaseUrl())(
  'GET /transactions/:id/edit-preview — cascade snapshot wiring (real DB)',
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
          receiptExternalUrl: 'https://etherscan.io/tx/0xcascadepreviewspec',
        },
        ADMIN_MAKSYM,
      )
    }

    async function seniorObligation() {
      const obligation = await dbSvc.db.query.pendingObligations.findFirst({
        where: eq(pendingObligations.creditorUserId, SENIOR.id),
      })
      if (!obligation) throw new Error('no senior obligation booked')
      return obligation
    }

    async function tableCounts() {
      // Sequential, not Promise.all — this is a single pg.Pool shared with the
      // rest of the suite; overlapping queries against one borrowed client
      // trip a node-postgres deprecation warning and are not worth risking
      // for a handful of COUNT(*) reads that only run twice per test.
      const tx = await dbSvc.db.select({ n: sql<number>`count(*)` }).from(transactions)
      const ob = await dbSvc.db.select({ n: sql<number>`count(*)` }).from(pendingObligations)
      const log = await dbSvc.db.select({ n: sql<number>`count(*)` }).from(transactionAuditLog)
      const sig = await dbSvc.db.select({ n: sql<number>`count(*)` }).from(invoiceSignatures)
      return {
        transactions: Number(tx[0]!.n),
        pendingObligations: Number(ob[0]!.n),
        transactionAuditLog: Number(log[0]!.n),
        invoiceSignatures: Number(sig[0]!.n),
      }
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
      // Deliberately no local try/catch around this: a connectivity failure
      // propagates as-is and fails `beforeAll` loudly (require-real-db.ts) —
      // an unmigrated `settled_amount`/`settled_share_percent` (task 1) is
      // the one thing THIS spec needs to check for itself.
      await assertRealDbSchema([
        { table: 'transactions', column: 'settled_amount' },
        { table: 'transactions', column: 'settled_share_percent' },
        { table: 'invoice_signatures', column: 'signer_role' },
      ])

      const moduleRef = await Test.createTestingModule({
        imports: [CascadePreviewTestModule],
      }).compile()
      await moduleRef.init()
      svc = moduleRef.get(TransactionsService)
      settleSvc = moduleRef.get(PendingSettlementService)
      dbSvc = moduleRef.get(DatabaseService)

      const db = dbSvc.db
      await db.delete(projects).where(eq(projects.id, PROJECT_ID))
      await clearLedger()
      await db.delete(users).where(inArray(users.id, TEST_OWN_USER_IDS))
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
            id: DROP.id,
            email: DROP.email,
            displayName: DROP.displayName,
            role: DROP.role,
            dropSharePercent: DROP_SHARE,
            googleId: `test-google-${DROP.id}`,
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
          name: 'Cascade Preview Project',
          companyName: 'Cascade Preview Co',
          domain: 'fintech',
          startDate: new Date('2025-01-01'),
          seniorId: SENIOR.id,
          dropId: DROP.id,
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

    // ── AC8 — ADMIN, both derivatives still PENDING ──────────────────────────
    it('ADMIN: derivatives still PENDING → recomputed share directly, no reconfirm', async () => {
      const income = await declare(1000)
      const plan = await svc.getEditCascadePreview(income.id, 2000, ADMIN_MAKSYM)

      expect(plan.editable).toBe(true)
      expect(plan.blockedReason).toBeNull()
      expect(plan.version).toEqual(expect.any(String))
      expect(plan.plan).not.toBeNull()
      expect(plan.plan!.sourceAmountChanged).toBe(true)
      expect(plan.plan!.oldSourceAmount).toBeCloseTo(1000, 6)
      expect(plan.plan!.newSourceAmount).toBeCloseTo(2000, 6)
      expect(plan.plan!.derivatives).toHaveLength(2)

      const senior = plan.plan!.derivatives.find((d) => d.type === 'SENIOR_PENDING_PAYOUT')!
      expect(senior.newAmount).toBeCloseTo((2000 * SENIOR_SHARE) / 100, 6)
      expect(senior.settledAmount).toBe(0)
      expect(senior.needsReconfirm).toBe(false)
      expect(senior.warnings).toEqual([])

      const drop = plan.plan!.derivatives.find((d) => d.type === 'DROP_PENDING_PAYOUT')!
      expect(drop.newAmount).toBeCloseTo((2000 * DROP_SHARE) / 100, 6)
      expect(drop.needsReconfirm).toBe(false)
    })

    // ── UX-1 (design fidelity, HIGH, reopened) ──────────────────────────────
    it('UX-1: each derivative names ITS OWN receiver, read from Postgres — never the source row’s', async () => {
      // Why this belongs in an INTEGRATION spec and not only in the unit
      // double: the fix is a Drizzle relational read
      // (`with: { receiver: { columns: { displayName: true } } }`), and a mock
      // that returns canned rows cannot tell a working join from a missing one
      // — it would answer the same either way. Only a real round-trip proves
      // the column arrives. (This is the same gap the SR-M-1 docblock in
      // `transaction-settled-exposure.unit.spec.ts` was corrected for claiming
      // a companion spec that did not exist; here the companion is real.)
      //
      // `declare()` books an ADMIN_INCOME — the MAIN path of this feature, and
      // exactly the shape where deriving the name from the source was wrong:
      // the source is received by the admin, each share by someone else.
      const income = await declare(1000)
      const plan = await svc.getEditCascadePreview(income.id, 2000, ADMIN_MAKSYM)

      const senior = plan.plan!.derivatives.find((d) => d.type === 'SENIOR_PENDING_PAYOUT')!
      const drop = plan.plan!.derivatives.find((d) => d.type === 'DROP_PENDING_PAYOUT')!

      expect(senior.receiverName).toBe(SENIOR.displayName)
      expect(drop.receiverName).toBe(DROP.displayName)
      // The defect itself, stated: the admin received the SOURCE, so their name
      // appearing on a share is the bug this test exists to prevent.
      expect(senior.receiverName).not.toBe(ADMIN_MAKSYM.displayName)
      expect(drop.receiverName).not.toBe(ADMIN_MAKSYM.displayName)
    })

    // ── AC8 — ADMIN, a derivative already settled (real settled_* columns) ───
    it('ADMIN: senior derivative already settled → plan reads REAL settled_amount/settled_share_percent, needsReconfirm true', async () => {
      const income = await declare(1000)
      const obligation = await seniorObligation()
      await settleSvc.settleByCompany(obligation.id, ADMIN_MAKSYM, {
        fundingSource: 'COMPANY_ACCOUNT',
        receiptExternalUrl: 'https://etherscan.io/tx/0xcascadepreviewspec',
      })

      const plan = await svc.getEditCascadePreview(income.id, 2000, ADMIN_MAKSYM)
      expect(plan.editable).toBe(true)
      const senior = plan.plan!.derivatives.find((d) => d.type === 'SENIOR_INCOME')!
      // settled_amount was written by the REAL settleByCompany flip — 26% of 1000.
      expect(senior.settledAmount).toBeCloseTo((1000 * SENIOR_SHARE) / 100, 6)
      expect(senior.sharePercent).toBe(SENIOR_SHARE)
      expect(senior.newAmount).toBeCloseTo((2000 * SENIOR_SHARE) / 100, 6)
      expect(senior.needsReconfirm).toBe(true)
      expect(senior.remainingToPay).toBeCloseTo(senior.newAmount! - senior.settledAmount, 6)
    })

    // ── AC8 — decrease below what was already settled → OVERPAYMENT, no reconfirm ─
    it('ADMIN: decrease below the settled amount → OVERPAYMENT warning, needsReconfirm false, remainingToPay 0', async () => {
      const income = await declare(1000)
      const obligation = await seniorObligation()
      await settleSvc.settleByCompany(obligation.id, ADMIN_MAKSYM, {
        fundingSource: 'COMPANY_ACCOUNT',
        receiptExternalUrl: 'https://etherscan.io/tx/0xcascadepreviewspec',
      })

      // 26% of 100 = 26, well under the 260 already settled.
      const plan = await svc.getEditCascadePreview(income.id, 100, ADMIN_MAKSYM)
      const senior = plan.plan!.derivatives.find((d) => d.type === 'SENIOR_INCOME')!
      expect(senior.needsReconfirm).toBe(false)
      expect(senior.remainingToPay).toBe(0)
      expect(senior.warnings.some((w) => w.code === 'OVERPAYMENT')).toBe(true)
    })

    // ── HIGH-1 (security-review round 1) — real DB: settled_amount survives a
    // cascade revert back to PENDING (AC3 "Механика возврата", task 3's future
    // mechanic) — simulated directly here since task 3 does not exist yet. The
    // point is `loadCascadeSnapshot` + the resolver reading the REAL row after
    // exactly that state transition, not just a hand-built snapshot.
    it('ADMIN: a settled derivative manually reverted to PENDING (settled_amount left untouched) still reports the REAL accumulator, not zero', async () => {
      const income = await declare(1000)
      const obligation = await seniorObligation()
      await settleSvc.settleByCompany(obligation.id, ADMIN_MAKSYM, {
        fundingSource: 'COMPANY_ACCOUNT',
        receiptExternalUrl: 'https://etherscan.io/tx/0xcascadepreviewspec',
      })

      // Simulate AC3's revert mechanic by hand (task 3 is not built yet):
      // obligation status back to PENDING, the derivative row back to
      // PENDING_PAYMENT with its live sharePercent snapshot RESTORED (AC3
      // point 3) — but settled_amount/settled_currency/settled_share_percent
      // (the monotonic accumulator from task 1) deliberately left alone.
      await dbSvc.db
        .update(pendingObligations)
        .set({ status: 'PENDING', closingTransactionId: null })
        .where(eq(pendingObligations.id, obligation.id))
      await dbSvc.db
        .update(transactions)
        .set({
          status: 'PENDING_PAYMENT',
          type: 'SENIOR_PENDING_PAYOUT',
          seniorSharePercent: SENIOR_SHARE,
        })
        .where(eq(transactions.id, obligation.sourceTransactionId))

      const plan = await svc.getEditCascadePreview(income.id, 2000, ADMIN_MAKSYM)
      const senior = plan.plan!.derivatives.find((d) => d.id === obligation.sourceTransactionId)!
      // The bug this pins: before the fix, a PENDING obligation forced
      // settledAmount to 0 regardless of what the row actually held.
      expect(senior.settledAmount).toBeCloseTo((1000 * SENIOR_SHARE) / 100, 6)
      expect(senior.newAmount).toBeCloseTo((2000 * SENIOR_SHARE) / 100, 6)
      expect(senior.remainingToPay).toBeCloseTo(senior.newAmount! - senior.settledAmount, 6)
    })

    // ── MED-A (security-review round 2) — real DB: the EXACT scenario the
    // finding named. A derivative reverted to PENDING (settled_amount left
    // untouched, same mechanic as the HIGH-1 test above), followed by a
    // SECOND edit whose recomputed share falls below that accumulator —
    // `remainingToPay: 0` alone is not enough, the OVERPAYMENT warning must
    // fire even though the row currently reads PENDING, not PAID.
    it('ADMIN: a reverted-to-PENDING derivative, edited a second time BELOW the accumulator → OVERPAYMENT warning fires despite the row being PENDING, not PAID', async () => {
      const income = await declare(1000)
      const obligation = await seniorObligation()
      await settleSvc.settleByCompany(obligation.id, ADMIN_MAKSYM, {
        fundingSource: 'COMPANY_ACCOUNT',
        receiptExternalUrl: 'https://etherscan.io/tx/0xcascadepreviewspec',
      })

      // Same hand-simulated revert as the HIGH-1 test above (task 3 does not
      // exist yet): obligation back to PENDING, derivative row back to
      // PENDING_PAYMENT with sharePercent restored, settled_amount left at
      // 26% of 1000 = 260.
      await dbSvc.db
        .update(pendingObligations)
        .set({ status: 'PENDING', closingTransactionId: null })
        .where(eq(pendingObligations.id, obligation.id))
      await dbSvc.db
        .update(transactions)
        .set({
          status: 'PENDING_PAYMENT',
          type: 'SENIOR_PENDING_PAYOUT',
          seniorSharePercent: SENIOR_SHARE,
        })
        .where(eq(transactions.id, obligation.sourceTransactionId))

      // Second edit: 26% of 100 = 26, below the 260 accumulator.
      const plan = await svc.getEditCascadePreview(income.id, 100, ADMIN_MAKSYM)
      const senior = plan.plan!.derivatives.find((d) => d.id === obligation.sourceTransactionId)!
      expect(senior.settledAmount).toBeCloseTo((1000 * SENIOR_SHARE) / 100, 6)
      expect(senior.newAmount).toBeCloseTo(26, 6)
      expect(senior.remainingToPay).toBe(0)
      // The bug this pins: the old `isSettled && ...` gate never fired here
      // because the row is PENDING, not PAID — money already paid out went
      // unflagged purely because of a status flip that does not undo it.
      expect(senior.warnings.some((w) => w.code === 'OVERPAYMENT')).toBe(true)
    })

    // ── HIGH-2 (security-review round 1) — real DB: a non-USDT settled_currency
    // is never subtracted from the USDT newAmount. The conversion WRITE path
    // (a real DROP settle in UAH/EUR/USD) is already proven by
    // `pending-settlement.drop-currency.spec.ts`; this spec's job is only the
    // READ side — `loadCascadeSnapshot` handing a non-USDT settled_currency to
    // the resolver honestly.
    it('ADMIN: a real row whose settled_currency is not USDT → remainingToPay null, no fabricated OVERPAYMENT', async () => {
      const income = await declare(1000)
      const obligation = await seniorObligation()
      await settleSvc.settleByCompany(obligation.id, ADMIN_MAKSYM, {
        fundingSource: 'COMPANY_ACCOUNT',
        receiptExternalUrl: 'https://etherscan.io/tx/0xcascadepreviewspec',
      })
      await dbSvc.db
        .update(transactions)
        .set({ settledCurrency: 'UAH' })
        .where(eq(transactions.id, obligation.sourceTransactionId))

      const plan = await svc.getEditCascadePreview(income.id, 2000, ADMIN_MAKSYM)
      const senior = plan.plan!.derivatives.find((d) => d.id === obligation.sourceTransactionId)!
      expect(senior.settledCurrency).toBe('UAH')
      expect(senior.remainingToPay).toBeNull()
      expect(senior.warnings.some((w) => w.code === 'NON_USDT_CURRENCY')).toBe(true)
      expect(senior.warnings.some((w) => w.code === 'OVERPAYMENT')).toBe(false)
    })

    // ── HIGH-2-residual (security-review round 2) — real DB: `loadCascadeSnapshot`
    // wires the SOURCE row's own `currency` column through to the resolver —
    // a settled_currency that matches the SOURCE row (not a hardcoded
    // 'USDT') is NOT flagged. `declareUsdtProjectIncome` always books
    // `currency: 'USDT'` today (BIZ-18 is what keeps it that way — task 3
    // lifts it), so the source row's currency is mutated directly here, the
    // same "simulate what a later task unlocks" pattern the HIGH-1 revert
    // test above already uses.
    it('ADMIN: a real SOURCE row whose currency is NOT USDT, settled in that SAME currency → no NON_USDT_CURRENCY warning', async () => {
      const income = await declare(1000)
      const obligation = await seniorObligation()
      await settleSvc.settleByCompany(obligation.id, ADMIN_MAKSYM, {
        fundingSource: 'COMPANY_ACCOUNT',
        receiptExternalUrl: 'https://etherscan.io/tx/0xcascadepreviewspec',
      })
      await dbSvc.db
        .update(transactions)
        .set({ currency: 'EUR' })
        .where(eq(transactions.id, income.id))
      await dbSvc.db
        .update(transactions)
        .set({ settledCurrency: 'EUR' })
        .where(eq(transactions.id, obligation.sourceTransactionId))

      const plan = await svc.getEditCascadePreview(income.id, 2000, ADMIN_MAKSYM)
      expect(plan.plan!.sourceCurrency).toBe('EUR')
      const senior = plan.plan!.derivatives.find((d) => d.id === obligation.sourceTransactionId)!
      // A hardcoded `!== 'USDT'` comparison would flag this row even though
      // nothing is mismatched — both the source and the settle read EUR.
      expect(senior.currency).toBe('EUR')
      expect(senior.warnings.some((w) => w.code === 'NON_USDT_CURRENCY')).toBe(false)
      expect(senior.remainingToPay).not.toBeNull()
    })

    // ── MED-1 (security-review round 1) — real DB: warnings about the SOURCE
    // row itself, not just its derivatives ───────────────────────────────────
    it('ADMIN: a PAID SOURCE row carrying originalAmount is BLOCKED, not merely warned about (CR-M-1)', async () => {
      // Task 3 round 2 warned here while `PATCH` refused the same row under
      // AC13 — the preview promising a save that cannot happen. Now both
      // answer from the one classifier.
      const income = await declare(1000)
      await dbSvc.db
        .update(transactions)
        .set({ originalAmount: '950.000000' })
        .where(eq(transactions.id, income.id))

      const plan = await svc.getEditCascadePreview(income.id, 2000, ADMIN_MAKSYM)
      expect(plan.editable).toBe(false)
      expect(plan.blockedReason).toBe('PAYMENT_FACT_RECORDED')
      expect(plan.plan).toBeNull()

      await dbSvc.db
        .update(transactions)
        .set({ originalAmount: null })
        .where(eq(transactions.id, income.id))
    })

    it('ADMIN: the same warning still surfaces where the write would NOT refuse', async () => {
      // AC13 fires only on a PAID row. On one still awaiting payment the
      // warning is the right answer, and the resolver keeps producing it.
      const income = await declare(1000)
      await dbSvc.db
        .update(transactions)
        .set({ originalAmount: '950.000000', status: 'PENDING_PAYMENT' })
        .where(eq(transactions.id, income.id))

      const plan = await svc.getEditCascadePreview(income.id, 2000, ADMIN_MAKSYM)
      expect(plan.editable).toBe(true)
      expect(plan.plan!.sourceWarnings).toEqual([
        { code: 'SOURCE_ORIGINAL_AMOUNT_SET', message: expect.stringContaining('950') },
      ])

      await dbSvc.db
        .update(transactions)
        .set({ originalAmount: null, status: 'PAID' })
        .where(eq(transactions.id, income.id))
    })

    it('ADMIN: a real COUNTERPARTY invoice_signatures row on the SOURCE id surfaces SOURCE_SIGNED_INVOICE', async () => {
      const income = await declare(1000)
      await dbSvc.db.insert(invoiceSignatures).values({
        transactionId: income.id,
        signerRole: 'COUNTERPARTY',
        signerId: SENIOR.id,
        pdfHash: 'b'.repeat(64),
        method: 'MANUAL_CLICK',
      })

      const plan = await svc.getEditCascadePreview(income.id, 2000, ADMIN_MAKSYM)
      expect(plan.plan!.sourceWarnings).toEqual([
        { code: 'SOURCE_SIGNED_INVOICE', message: expect.any(String) },
      ])

      await dbSvc.db.delete(invoiceSignatures).where(eq(invoiceSignatures.transactionId, income.id))
    })

    // ── AC4 warning wiring — a REAL counterparty invoice signature ───────────
    it('a real COUNTERPARTY invoice_signatures row surfaces as SIGNED_INVOICE', async () => {
      const income = await declare(1000)
      const obligation = await seniorObligation()
      const { created } = await settleSvc.settleByCompany(obligation.id, ADMIN_MAKSYM, {
        fundingSource: 'COMPANY_ACCOUNT',
        receiptExternalUrl: 'https://etherscan.io/tx/0xcascadepreviewspec',
      })
      const flippedId = created[0]!.id

      await dbSvc.db.insert(invoiceSignatures).values({
        transactionId: flippedId,
        signerRole: 'COUNTERPARTY',
        signerId: SENIOR.id,
        pdfHash: 'a'.repeat(64),
        method: 'MANUAL_CLICK',
      })

      const plan = await svc.getEditCascadePreview(income.id, 2000, ADMIN_MAKSYM)
      const senior = plan.plan!.derivatives.find((d) => d.id === flippedId)!
      expect(senior.warnings.some((w) => w.code === 'SIGNED_INVOICE')).toBe(true)

      await dbSvc.db.delete(invoiceSignatures).where(eq(invoiceSignatures.transactionId, flippedId))
    })

    // ── AC6 case 8 — дельта == 0 ──────────────────────────────────────────────
    it('proposing the SAME amount → sourceAmountChanged false, no derivatives computed', async () => {
      const income = await declare(1000)
      const plan = await svc.getEditCascadePreview(income.id, 1000, ADMIN_MAKSYM)
      expect(plan.plan!.sourceAmountChanged).toBe(false)
      expect(plan.plan!.derivatives).toEqual([])
    })

    // ── AC8 — RBAC (service-level; HTTP-level guard wiring is proven separately
    // in finance-controller-guards.rbac.integration.spec.ts) ─────────────────
    it('non-ADMIN → ForbiddenException', async () => {
      const income = await declare(1000)
      await expect(svc.getEditCascadePreview(income.id, 2000, SENIOR)).rejects.toBeInstanceOf(
        ForbiddenException,
      )
    })

    // ── AC8 — nonexistent id ──────────────────────────────────────────────────
    it('nonexistent id → NotFoundException', async () => {
      await expect(
        svc.getEditCascadePreview(randomUUID(), 2000, ADMIN_MAKSYM),
      ).rejects.toBeInstanceOf(NotFoundException)
    })

    // ── AC8 — guard 1 (PAYOUT family) — blocked in the PLAN, not a throw ─────
    it('PAYOUT-family row → editable false, blockedReason PAYOUT_FAMILY (does not throw)', async () => {
      const [row] = await dbSvc.db
        .insert(transactions)
        .values({
          type: 'PAYOUT',
          status: 'PAID',
          amount: '100',
          currency: 'USDT',
          senderId: SENIOR.id,
          fundingSource: 'COMPANY_ACCOUNT',
          createdBy: MAKSYM_ID,
        })
        .returning()

      const plan = await svc.getEditCascadePreview(row!.id, 200, ADMIN_MAKSYM)
      expect(plan.editable).toBe(false)
      expect(plan.blockedReason).toBe('PAYOUT_FAMILY')
      expect(plan.plan).toBeNull()
      expect(plan.version).toBeNull()

      await dbSvc.db.delete(transactions).where(eq(transactions.id, row!.id))
    })

    // ── AC8 — guard 2 (linked to a payout request) — blocked in the PLAN ─────
    it('a row carrying payoutRequestId → editable false, blockedReason LINKED_TO_PAYOUT_REQUEST', async () => {
      const [payoutRequest] = await dbSvc.db
        .insert(payoutRequests)
        .values({
          seniorId: SENIOR.id,
          incomeAmount: '1000',
          payableAmount: '740',
          contractAddress: '0x0000000000000000000000000000000000dEaD',
        })
        .returning()
      const [row] = await dbSvc.db
        .insert(transactions)
        .values({
          type: 'SENIOR_INCOME',
          status: 'VALIDATED',
          amount: '740',
          currency: 'USDT',
          receiverId: SENIOR.id,
          payoutRequestId: payoutRequest!.id,
          createdBy: MAKSYM_ID,
        })
        .returning()

      const plan = await svc.getEditCascadePreview(row!.id, 800, ADMIN_MAKSYM)
      expect(plan.editable).toBe(false)
      expect(plan.blockedReason).toBe('LINKED_TO_PAYOUT_REQUEST')
      expect(plan.plan).toBeNull()

      await dbSvc.db.delete(transactions).where(eq(transactions.id, row!.id))
      await dbSvc.db.delete(payoutRequests).where(eq(payoutRequests.id, payoutRequest!.id))
    })

    // MED-3 (security-review round 1): row COUNTS alone are blind to an
    // in-place UPDATE — same count, mutated content. Captures the exact rows
    // the preview reads (source income, the settled derivative, its
    // obligation) so an accidental write that a naive COUNT(*) would miss
    // entirely (e.g. a stray `.update()` that touches an existing row) fails
    // this test.
    async function rowFingerprints(incomeId: string, derivativeId: string, obligationId: string) {
      const [incomeRow] = await dbSvc.db
        .select()
        .from(transactions)
        .where(eq(transactions.id, incomeId))
      const [derivRow] = await dbSvc.db
        .select()
        .from(transactions)
        .where(eq(transactions.id, derivativeId))
      const [oblRow] = await dbSvc.db
        .select()
        .from(pendingObligations)
        .where(eq(pendingObligations.id, obligationId))
      return { incomeRow, derivRow, oblRow }
    }

    // ── AC9 — zero DB writes, whatever the outcome ────────────────────────────
    it('AC9: the endpoint writes NOTHING — row counts AND row content are identical before and after, across every outcome above', async () => {
      const income = await declare(1000)
      const obligation = await seniorObligation()
      await settleSvc.settleByCompany(obligation.id, ADMIN_MAKSYM, {
        fundingSource: 'COMPANY_ACCOUNT',
        receiptExternalUrl: 'https://etherscan.io/tx/0xcascadepreviewspec',
      })

      const before = await tableCounts()
      const rowsBefore = await rowFingerprints(
        income.id,
        obligation.sourceTransactionId,
        obligation.id,
      )

      await svc.getEditCascadePreview(income.id, 5000, ADMIN_MAKSYM) // editable, both branches (settled + pending)
      await svc.getEditCascadePreview(income.id, 1000, ADMIN_MAKSYM) // delta == 0
      await expect(svc.getEditCascadePreview(income.id, 2000, SENIOR)).rejects.toThrow() // 403 path
      await expect(svc.getEditCascadePreview(randomUUID(), 2000, ADMIN_MAKSYM)).rejects.toThrow() // 404 path

      const after = await tableCounts()
      expect(after).toEqual(before)

      // MED-3: content-level check — an UPDATE that left row counts alone
      // (e.g. a stray `updatedAt` bump) would pass the counts assert above
      // and fail here.
      const rowsAfter = await rowFingerprints(
        income.id,
        obligation.sourceTransactionId,
        obligation.id,
      )
      expect(rowsAfter).toEqual(rowsBefore)
    })
  },
)
