import { Global, Module } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq, inArray } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { MAKSYM_ID, KOSTYA_ID, COMPANY_ACCOUNT_RECEIVER, roundShareAmount } from '@crm/shared'

import { DatabaseService } from '../database/database.service'
import { TransactionsService } from './transactions.service'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'
import { sweepOrphanConsumedTxHashes } from './__test-helpers__/consumed-tx-hashes'
import type { EtherscanService } from './etherscan.service'
import type { NbuCurrencyService } from './nbu-currency.service'
import { pendingObligations, projects, transactions, users } from '../database/schema'
import * as schema from '../database/schema'
import { hasDatabaseUrl } from '../test/require-real-db'

/**
 * task-admin-income-unified — real-DB proof of the task's core invariant and
 * its PRIMARY test (AC6).
 *
 * THE INCIDENT THIS PINS: a prod ADMIN_INCOME row on a USDT-payment project
 * (GamingTec, 4708.69 USDT) had NO drop share — `createAdminIncome` never
 * calls `bookCompanyObligations`, and a human had used it on a USDT project
 * instead of `declareUsdtProjectIncome`. The fix removes the choice (one
 * unified web form routes by `project.paymentType`); this spec proves the
 * SERVER-side half holds regardless of what any client sends:
 *
 *   AC4 — `createAdminIncome` REFUSES a USDT-payment project outright (no
 *         request can reach the one writer that skips obligation-booking).
 *   AC2 — the route that DOES accept a USDT project (`declareUsdtProjectIncome`,
 *         unchanged) books the drop share atomically with the income —
 *         proven on an admin-owned project (no senior IOU: the admin IS the
 *         senior) AND a third-party one (both IOUs, reachable only because
 *         the unified project pool is not narrowed to the caller's own — ADR
 *         D3 / AC11).
 *   AC3 — the non-USDT route (`createAdminIncome`) books NO obligation at
 *         all, even when the project has a drop bound (that drop declares
 *         their own DROP_INCOME separately — booking here would double it).
 *   AC6 (PRIMARY TEST OF THE TASK) — the amount the web banner PREDICTS
 *         (`roundShareAmount`, `@crm/shared` — the exact same import the
 *         component uses, not a re-derivation) equals the amount the server
 *         ACTUALLY books, to the last decimal (`toBe`, not `toBeCloseTo`).
 *
 * Run against a scratch DB (NEVER the live crm_db):
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_qa \
 *     pnpm --filter @crm/api test -- admin-income-unified.integration
 */

const ADMIN_MAKSYM: SessionUser = {
  id: MAKSYM_ID,
  email: 'unified-maksym@test.spec',
  displayName: 'Unified Maksym',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 0,
  legalFullName: null,
}
const ADMIN_KOSTYA: SessionUser = {
  ...ADMIN_MAKSYM,
  id: KOSTYA_ID,
  email: 'unified-kostya@test.spec',
  displayName: 'Unified Kostya',
}
const SENIOR: SessionUser = {
  id: 'be550000-0000-4000-aa00-000000000001',
  email: 'unified-senior@test.spec',
  displayName: 'Unified Senior',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}
const DROP: SessionUser = {
  ...SENIOR,
  id: 'be550000-0000-4000-aa00-000000000002',
  email: 'unified-drop@test.spec',
  displayName: 'Unified Drop',
  role: 'DROP',
}
const ACCOUNTANT: SessionUser = {
  ...SENIOR,
  id: 'be550000-0000-4000-aa00-000000000003',
  email: 'unified-accountant@test.spec',
  displayName: 'Unified Accountant',
  role: 'ACCOUNTANT',
  seniorSharePercent: 0,
}

const TEST_OWN_USERS = [SENIOR, DROP, ACCOUNTANT]
const TEST_OWN_USER_IDS = TEST_OWN_USERS.map((u) => u.id)

// ADMIN_OWN_USDT_PROJECT: MAKSYM is the senior AND declares — the server
// never books a senior IOU for an admin-senior, so only the drop share is
// expected. Amount matches the real prod incident (4708.69 USDT) on purpose.
const ADMIN_OWN_USDT_PROJECT = 'be550000-0000-4000-bb00-000000000001'
// THIRD_PARTY_USDT_PROJECT: senior is a genuine SENIOR (not an admin) — reachable
// by MAKSYM only because the unified pool includes ANY USDT project (ADR D3),
// not just the caller's own. BOTH senior and drop IOUs are expected.
const THIRD_PARTY_USDT_PROJECT = 'be550000-0000-4000-bb00-000000000002'
// ADMIN_OWN_FOP_PROJECT: non-USDT, but STILL has a drop bound — proves AC3
// (createAdminIncome books nothing) is not vacuously true for lack of a drop.
const ADMIN_OWN_FOP_PROJECT = 'be550000-0000-4000-bb00-000000000003'
const MY_PROJECT_IDS = [ADMIN_OWN_USDT_PROJECT, THIRD_PARTY_USDT_PROJECT, ADMIN_OWN_FOP_PROJECT]

const DROP_SHARE = 5 // DROP.dropSharePercent (user default)
const SENIOR_SHARE = 26 // SENIOR.seniorSharePercent (user default)
const DROP_OVERRIDE = 12 // THIRD_PARTY_USDT_PROJECT.dropSharePercentOverride

const fakeNbu: Pick<NbuCurrencyService, 'getRates'> = {
  getRates: () =>
    Promise.resolve({ usdUah: '40.0000', usdtUah: '40.0000', eurUah: '44.0000', date: '20260812' }),
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
  ],
})
class UnifiedTestModule {}

describe.skipIf(!hasDatabaseUrl())(
  'admin-income-unified — createAdminIncome refuses USDT, declareUsdtProjectIncome books it, prediction == result (real DB)',
  () => {
    let svc: TransactionsService
    let dbSvc: DatabaseService

    // Same idempotency-key-per-call convention as the sibling USDT specs — each
    // declaration in this file is a distinct income.
    function declare(
      body: Omit<Parameters<TransactionsService['declareUsdtProjectIncome']>[0], 'idempotencyKey'>,
      user: SessionUser,
    ) {
      return svc.declareUsdtProjectIncome(
        {
          receiptExternalUrl: 'https://etherscan.io/tx/0xadminincomeunifiedspec',
          ...body,
          idempotencyKey: randomUUID(),
        },
        user,
      )
    }

    async function clearLedger() {
      await dbSvc.db
        .delete(pendingObligations)
        .where(inArray(pendingObligations.creditorUserId, [...TEST_OWN_USER_IDS, MAKSYM_ID]))
      await dbSvc.db.delete(transactions).where(inArray(transactions.projectId, MY_PROJECT_IDS))
      await sweepOrphanConsumedTxHashes(dbSvc)
    }

    async function obligationsFor(
      creditorId: string,
    ): Promise<{ id: string; amount: string; sourceType: string | null }[]> {
      const rows = await dbSvc.db
        .select({
          id: pendingObligations.id,
          amount: pendingObligations.amount,
          sourceType: transactions.type,
        })
        .from(pendingObligations)
        .leftJoin(transactions, eq(pendingObligations.sourceTransactionId, transactions.id))
        .where(eq(pendingObligations.creditorUserId, creditorId))
      return rows
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
          throw new Error('[admin-income-unified] FAILED — project_payment_type enum not found')
        }
      } catch {
        throw new Error('[admin-income-unified] FAILED — no DB reachable at DATABASE_URL')
      }

      const moduleRef = await Test.createTestingModule({ imports: [UnifiedTestModule] }).compile()
      await moduleRef.init()
      svc = moduleRef.get(TransactionsService)
      dbSvc = moduleRef.get(DatabaseService)

      const db = dbSvc.db
      await db.delete(projects).where(inArray(projects.id, MY_PROJECT_IDS))
      await clearLedger()
      // Only ever delete OUR OWN synthetic users (TEST_OWN_USER_IDS). MAKSYM_ID
      // / KOSTYA_ID are the real canonical admins already seeded in crm_qa and
      // referenced from other tables (e.g. vacancies.created_by) — deleting
      // them 23503s and would corrupt shared fixture data for every other spec.
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

      await db
        .insert(projects)
        .values([
          {
            id: ADMIN_OWN_USDT_PROJECT,
            name: 'Unified Admin-Own USDT Project',
            companyName: 'Unified AdminCorp',
            domain: 'ai',
            startDate: new Date('2025-01-01'),
            seniorId: MAKSYM_ID,
            dropId: DROP.id,
            currency: 'USDT',
            rate: 1000,
            paymentType: 'USDT',
          },
          {
            id: THIRD_PARTY_USDT_PROJECT,
            name: 'Unified Third-Party USDT Project',
            companyName: 'Unified ThirdPartyCorp',
            domain: 'fintech',
            startDate: new Date('2025-01-01'),
            seniorId: SENIOR.id,
            dropId: DROP.id,
            currency: 'USDT',
            rate: 1000,
            paymentType: 'USDT',
            dropSharePercentOverride: DROP_OVERRIDE,
          },
          {
            id: ADMIN_OWN_FOP_PROJECT,
            name: 'Unified Admin-Own FOP Project',
            companyName: 'Unified FopCorp',
            domain: 'ai',
            startDate: new Date('2025-01-01'),
            seniorId: MAKSYM_ID,
            dropId: DROP.id,
            currency: 'USD',
            rate: 1000,
            paymentType: 'FOP',
          },
        ])
        .onConflictDoNothing()
    })

    beforeEach(async () => {
      await clearLedger()
    })

    afterAll(async () => {
      if (dbSvc) {
        await clearLedger()
        await dbSvc.db.delete(projects).where(inArray(projects.id, MY_PROJECT_IDS))
        await dbSvc.db.delete(users).where(inArray(users.id, TEST_OWN_USER_IDS))
      }
      if (_pool) await _pool.end()
    })

    // ── AC4: createAdminIncome refuses ANY USDT-payment project ────────────────
    it('AC4: createAdminIncome refuses a USDT-payment project — no request reaches the writer that skips obligations', async () => {
      await expect(
        svc.createAdminIncome(
          {
            projectId: ADMIN_OWN_USDT_PROJECT,
            amount: 500,
            currency: 'USDT',
            receiptExternalUrl: 'https://etherscan.io/tx/0xadminincomeunifiedspecguard',
          },
          ADMIN_MAKSYM,
        ),
      ).rejects.toThrow(/declareUsdtProjectIncome/)

      // ACCOUNTANT hits the exact same guard (defense-in-depth for BOTH callers
      // of createAdminIncome — the accountant is also an admin-owned-project
      // recorder and could otherwise reach the same hole).
      await expect(
        svc.createAdminIncome(
          {
            projectId: ADMIN_OWN_USDT_PROJECT,
            amount: 500,
            currency: 'USDT',
            receiptExternalUrl: 'https://etherscan.io/tx/0xadminincomeunifiedspecguard2',
          },
          ACCOUNTANT,
        ),
      ).rejects.toThrow(/declareUsdtProjectIncome/)

      // No transaction, no obligation — the rejected calls left no trace.
      const rows = await dbSvc.db.query.transactions.findMany({
        where: (t, { eq }) => eq(t.projectId, ADMIN_OWN_USDT_PROJECT),
      })
      expect(rows).toHaveLength(0)
    })

    // ── AC2 + AC6 (PRIMARY): admin-own USDT project — drop share only ─────────
    it('AC2/AC6: admin-owned USDT project — drop IOU booked, amount matches roundShareAmount EXACTLY (real prod incident amount)', async () => {
      const incomeAmount = 4708.69 // the exact amount from the GamingTec incident

      const income = await declare(
        {
          projectId: ADMIN_OWN_USDT_PROJECT,
          amount: incomeAmount,
          receiverId: COMPANY_ACCOUNT_RECEIVER,
        },
        ADMIN_MAKSYM,
      )
      expect(income.type).toBe('ADMIN_INCOME')

      // No senior IOU — MAKSYM (the senior) is an ADMIN.
      expect(await obligationsFor(MAKSYM_ID)).toHaveLength(0)

      // The drop IOU — this IS the "плашка" prediction, computed with the SAME
      // shared function the web banner imports, not a re-derivation.
      const predicted = roundShareAmount(incomeAmount, DROP_SHARE)
      const dropObls = await obligationsFor(DROP.id)
      expect(dropObls).toHaveLength(1)
      expect(dropObls[0]!.sourceType).toBe('DROP_PENDING_PAYOUT')
      // toBe, not toBeCloseTo — AC6 demands EXACT agreement, to the last decimal.
      expect(parseFloat(dropObls[0]!.amount)).toBe(predicted)
    })

    // ── AC2 continued: third-party USDT project — BOTH IOUs ────────────────────
    it('AC2/AC11: third-party USDT project (reachable only via the unified pool) — both IOUs match roundShareAmount exactly', async () => {
      const incomeAmount = 1000

      await declare(
        {
          projectId: THIRD_PARTY_USDT_PROJECT,
          amount: incomeAmount,
          receiverId: COMPANY_ACCOUNT_RECEIVER,
        },
        ADMIN_MAKSYM,
      )

      const predictedSenior = roundShareAmount(incomeAmount, SENIOR_SHARE)
      const seniorObls = await obligationsFor(SENIOR.id)
      expect(seniorObls).toHaveLength(1)
      expect(seniorObls[0]!.sourceType).toBe('SENIOR_PENDING_PAYOUT')
      expect(parseFloat(seniorObls[0]!.amount)).toBe(predictedSenior)

      const predictedDrop = roundShareAmount(incomeAmount, DROP_OVERRIDE)
      const dropObls = await obligationsFor(DROP.id)
      expect(dropObls).toHaveLength(1)
      expect(dropObls[0]!.sourceType).toBe('DROP_PENDING_PAYOUT')
      expect(parseFloat(dropObls[0]!.amount)).toBe(predictedDrop)
    })

    // ── AC3: non-USDT project books NOTHING, even with a drop bound ────────────
    it('AC3: createAdminIncome on a non-USDT project books NO obligation — even though the project has a drop bound', async () => {
      const income = await svc.createAdminIncome(
        {
          projectId: ADMIN_OWN_FOP_PROJECT,
          amount: 500,
          currency: 'USD',
          receiptExternalUrl: 'https://example.com/receipt.png',
        },
        ADMIN_MAKSYM,
      )
      expect(income.type).toBe('ADMIN_INCOME')
      expect(await obligationsFor(DROP.id)).toHaveLength(0)
      expect(await obligationsFor(MAKSYM_ID)).toHaveLength(0)
    })
  },
)
