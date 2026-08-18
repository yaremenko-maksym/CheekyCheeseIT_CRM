import { Global, Module } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { drizzle } from 'drizzle-orm/node-postgres'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { MAKSYM_ID, KOSTYA_ID, COMPANY_ACCOUNT_RECEIVER } from '@crm/shared'

import { DatabaseService } from '../database/database.service'
import { TransactionsService } from './transactions.service'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'
import type { EtherscanService } from './etherscan.service'
import type { NbuCurrencyService } from './nbu-currency.service'
import { pendingObligations, projects, transactions, users } from '../database/schema'
import * as schema from '../database/schema'
import { hasDatabaseUrl } from '../test/require-real-db'

/**
 * Security-review PR #367 (MED-1) — declareUsdtProjectIncome idempotency.
 *
 * Real-DB integration (NOT mocked — feedback_mocked_e2e_guards) proving the
 * dividend-BIZ-19 idempotency contract, mirrored 1:1 onto the admin-USDT income
 * flow:
 *   AC2  same key twice → ONE ADMIN_INCOME + ONE obligation set (senior + drop
 *        shares NOT doubled); second call returns the existing row.
 *   AC3  two different keys → TWO independent incomes + TWO obligation sets.
 *   AC4  concurrent duplicate submit that slips past the early-SELECT collides on
 *        uq_transactions_admin_income_idempotency_key (23505) → idempotent
 *        response (existing row), NOT a 500, still exactly ONE income + set.
 *   AC4b out-of-band row with the key (early-SELECT hit) → service returns it and
 *        books NO obligations (early-return skips bookCompanyObligations).
 *
 * Run against a scratch DB (NEVER the live crm_db):
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_qa \
 *     pnpm --filter @crm/api test -- usdt-income-idempotency.integration
 *
 * DB-SKIP-GUARD: skips when DATABASE_URL is unreachable, the
 * project_payment_type enum / idempotency_key column are not migrated, or the
 * ADMIN_INCOME partial unique index is absent (AC4 needs the index).
 */

const SENIOR: SessionUser = {
  id: 'de550000-0000-4000-bb00-000000000001',
  email: 'usdt-idem-senior@test.spec',
  displayName: 'USDT Idem Senior',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}
const DROP: SessionUser = {
  ...SENIOR,
  id: 'de550000-0000-4000-bb00-000000000002',
  email: 'usdt-idem-drop@test.spec',
  displayName: 'USDT Idem Drop',
  role: 'DROP',
}
const ADMIN_MAKSYM: SessionUser = {
  ...SENIOR,
  id: MAKSYM_ID,
  email: 'usdt-idem-maksym@test.spec',
  displayName: 'USDT Idem Maksym',
  role: 'ADMIN',
  seniorSharePercent: 0,
}
const ADMIN_KOSTYA: SessionUser = {
  ...ADMIN_MAKSYM,
  id: KOSTYA_ID,
  email: 'usdt-idem-kostya@test.spec',
  displayName: 'USDT Idem Kostya',
}

// Only SENIOR/DROP are THIS spec's own users — MAKSYM/KOSTYA are the canonical
// admins and must never be blanket-deleted (would nuke seed/other-spec rows).
const TEST_OWN_USERS = [SENIOR, DROP]
const TEST_OWN_USER_IDS = TEST_OWN_USERS.map((u) => u.id)

const USDT_DROP_PROJECT = 'de550000-0000-4000-dd00-000000000001'
const MY_PROJECT_IDS = [USDT_DROP_PROJECT]

const DROP_SHARE = 5

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
class UsdtIdemTestModule {}

describe.skipIf(!hasDatabaseUrl())(
  'declareUsdtProjectIncome idempotency (real DB, PR #367 MED-1)',
  () => {
    let svc: TransactionsService
    let dbSvc: DatabaseService

    // Surgical cleanup — never a blanket delete by MAKSYM/KOSTYA id.
    async function clearLedger() {
      await dbSvc.db
        .delete(pendingObligations)
        .where(inArray(pendingObligations.creditorUserId, TEST_OWN_USER_IDS))
      await dbSvc.db.delete(transactions).where(inArray(transactions.projectId, MY_PROJECT_IDS))
    }

    async function countTxType(type: string, projectId: string): Promise<number> {
      const rows = await dbSvc.db
        .select({ c: sql<string>`COUNT(*)` })
        .from(transactions)
        .where(and(eq(transactions.type, type as never), eq(transactions.projectId, projectId)))
      return parseInt(rows[0]?.c ?? '0', 10)
    }

    async function obligationsFor(creditorId: string): Promise<number> {
      const rows = await dbSvc.db
        .select({ c: sql<string>`COUNT(*)` })
        .from(pendingObligations)
        .where(eq(pendingObligations.creditorUserId, creditorId))
      return parseInt(rows[0]?.c ?? '0', 10)
    }

    beforeAll(async () => {
      try {
        const probe = new Pool({ connectionString: process.env['DATABASE_URL'] })
        await probe.query('SELECT 1')
        const enumOk = await probe.query(
          `SELECT 1 FROM pg_type WHERE typname='project_payment_type' LIMIT 1`,
        )
        const colOk = await probe.query(
          `SELECT 1 FROM information_schema.columns
         WHERE table_name='transactions' AND column_name='idempotency_key' LIMIT 1`,
        )
        const idxOk = await probe.query(
          `SELECT 1 FROM pg_indexes
         WHERE indexname='uq_transactions_admin_income_idempotency_key' LIMIT 1`,
        )
        await probe.end()
        if (enumOk.rowCount === 0 || colOk.rowCount === 0 || idxOk.rowCount === 0) {
          throw new Error(
            '[usdt-income-idempotency] FAILED — payment_type enum / idempotency_key column / admin_income index not migrated',
          )
        }
      } catch {
        throw new Error('[usdt-income-idempotency] FAILED — no DB reachable at DATABASE_URL')
      }

      const moduleRef = await Test.createTestingModule({ imports: [UsdtIdemTestModule] }).compile()
      await moduleRef.init()
      svc = moduleRef.get(TransactionsService)
      dbSvc = moduleRef.get(DatabaseService)

      const db = dbSvc.db
      await db.delete(projects).where(inArray(projects.id, MY_PROJECT_IDS))
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

      // USDT drop-project: senior (non-admin) + drop bound, no override → drop 5%.
      await db
        .insert(projects)
        .values([
          {
            id: USDT_DROP_PROJECT,
            name: 'USDT Idem Drop Project',
            companyName: 'USDT Idem DropCorp',
            domain: 'fintech',
            startDate: new Date('2025-01-01'),
            seniorId: SENIOR.id,
            dropId: DROP.id,
            currency: 'USDT',
            rate: 1000,
            paymentType: 'USDT',
          },
        ])
        .onConflictDoNothing()
    }, 30_000)

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
    }, 15_000)

    // ── AC2: replay with the same key ──────────────────────────────────────────
    it('AC2: same key twice → ONE ADMIN_INCOME + ONE obligation set, second call returns existing', async () => {
      const key = randomUUID()

      const first = await svc.declareUsdtProjectIncome(
        {
          projectId: USDT_DROP_PROJECT,
          amount: 1000,
          receiverId: COMPANY_ACCOUNT_RECEIVER,
          idempotencyKey: key,
          receiptExternalUrl: 'https://etherscan.io/tx/0xusdtincomeidempotencyspec',
        },
        ADMIN_MAKSYM,
      )
      const second = await svc.declareUsdtProjectIncome(
        {
          projectId: USDT_DROP_PROJECT,
          amount: 1000,
          receiverId: COMPANY_ACCOUNT_RECEIVER,
          idempotencyKey: key,
          receiptExternalUrl: 'https://etherscan.io/tx/0xusdtincomeidempotencyspec',
        },
        ADMIN_MAKSYM,
      )

      // Idempotent — the replay returns the SAME transaction id.
      expect(second.id).toBe(first.id)
      // Exactly ONE ADMIN_INCOME on the project — no second income.
      expect(await countTxType('ADMIN_INCOME', USDT_DROP_PROJECT)).toBe(1)
      // Obligations NOT doubled: exactly one senior IOU + one drop IOU.
      expect(await obligationsFor(SENIOR.id)).toBe(1)
      expect(await obligationsFor(DROP.id)).toBe(1)
    }, 30_000)

    // ── AC3: distinct keys are independent ─────────────────────────────────────
    it('AC3: two different keys → TWO incomes + TWO obligation sets', async () => {
      await svc.declareUsdtProjectIncome(
        {
          projectId: USDT_DROP_PROJECT,
          amount: 1000,
          receiverId: COMPANY_ACCOUNT_RECEIVER,
          idempotencyKey: randomUUID(),
          receiptExternalUrl: 'https://etherscan.io/tx/0xusdtincomeidempotencyspec',
        },
        ADMIN_MAKSYM,
      )
      await svc.declareUsdtProjectIncome(
        {
          projectId: USDT_DROP_PROJECT,
          amount: 1000,
          receiverId: COMPANY_ACCOUNT_RECEIVER,
          idempotencyKey: randomUUID(),
          receiptExternalUrl: 'https://etherscan.io/tx/0xusdtincomeidempotencyspec',
        },
        ADMIN_MAKSYM,
      )

      expect(await countTxType('ADMIN_INCOME', USDT_DROP_PROJECT)).toBe(2)
      expect(await obligationsFor(SENIOR.id)).toBe(2)
      expect(await obligationsFor(DROP.id)).toBe(2)
    }, 30_000)

    // ── AC4: concurrent race collides on the unique index (23505) ──────────────
    it('AC4: concurrent duplicate submit → both fulfilled with SAME id, exactly ONE income + set (no 500)', async () => {
      const key = randomUUID()

      // Both calls miss the early-SELECT (they run before either commits). Under the
      // partial unique index one INSERT wins, the other hits 23505, the catch
      // re-reads the committed winner and returns it — no rejection, no double book.
      const results = await Promise.allSettled([
        svc.declareUsdtProjectIncome(
          {
            projectId: USDT_DROP_PROJECT,
            amount: 1000,
            receiverId: COMPANY_ACCOUNT_RECEIVER,
            idempotencyKey: key,
            receiptExternalUrl: 'https://etherscan.io/tx/0xusdtincomeidempotencyspec',
          },
          ADMIN_MAKSYM,
        ),
        svc.declareUsdtProjectIncome(
          {
            projectId: USDT_DROP_PROJECT,
            amount: 1000,
            receiverId: COMPANY_ACCOUNT_RECEIVER,
            idempotencyKey: key,
            receiptExternalUrl: 'https://etherscan.io/tx/0xusdtincomeidempotencyspec',
          },
          ADMIN_MAKSYM,
        ),
      ])

      expect(results[0]!.status).toBe('fulfilled')
      expect(results[1]!.status).toBe('fulfilled')
      const ids = results
        .filter((r): r is PromiseFulfilledResult<{ id: string }> => r.status === 'fulfilled')
        .map((r) => r.value.id)
      expect(ids[0]).toBe(ids[1])

      expect(await countTxType('ADMIN_INCOME', USDT_DROP_PROJECT)).toBe(1)
      expect(await obligationsFor(SENIOR.id)).toBe(1)
      expect(await obligationsFor(DROP.id)).toBe(1)
    }, 30_000)

    // ── AC4b: out-of-band row with the key → early-SELECT returns it, no obligations
    it('AC4b: pre-existing ADMIN_INCOME with the key → returns it and books NO obligations', async () => {
      const key = randomUUID()

      // Insert an ADMIN_INCOME carrying the key directly (bypassing the service, so
      // no obligations exist for it). A service call with the SAME key must hit the
      // early-SELECT, return the existing row, and NOT book any obligations.
      const [preexisting] = await dbSvc.db
        .insert(transactions)
        .values({
          type: 'ADMIN_INCOME',
          status: 'PAID',
          amount: '1000',
          currency: 'USDT',
          receiverId: MAKSYM_ID,
          projectId: USDT_DROP_PROJECT,
          fundingSource: 'COMPANY_ACCOUNT',
          idempotencyKey: key,
          receiptExternalUrl: 'https://etherscan.io/tx/0xusdtincomeidempotencyspec',
          createdBy: MAKSYM_ID,
        })
        .returning()

      const res = await svc.declareUsdtProjectIncome(
        {
          projectId: USDT_DROP_PROJECT,
          amount: 1000,
          receiverId: COMPANY_ACCOUNT_RECEIVER,
          idempotencyKey: key,
          receiptExternalUrl: 'https://etherscan.io/tx/0xusdtincomeidempotencyspec',
        },
        ADMIN_MAKSYM,
      )

      expect(res.id).toBe(preexisting!.id)
      expect(await countTxType('ADMIN_INCOME', USDT_DROP_PROJECT)).toBe(1)
      // Early-return skipped bookCompanyObligations entirely.
      expect(await obligationsFor(SENIOR.id)).toBe(0)
      expect(await obligationsFor(DROP.id)).toBe(0)
    }, 30_000)
  },
)
