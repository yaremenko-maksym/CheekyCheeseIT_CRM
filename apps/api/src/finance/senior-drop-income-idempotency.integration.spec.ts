import { Global, Module } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { drizzle } from 'drizzle-orm/node-postgres'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { MAKSYM_ID, createSeniorIncomeSchema, createDropIncomeSchema } from '@crm/shared'

import { DatabaseService } from '../database/database.service'
import { TransactionsService } from './transactions.service'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'
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
 * backlog 73/A-3 (security, finance audit 2026-08-17) — createSeniorIncome /
 * createDropIncome idempotency.
 *
 * Real-DB integration (NOT mocked — feedback_mocked_e2e_guards) mirroring the
 * proof shape `usdt-income-idempotency.integration.spec.ts` uses for
 * declareUsdtProjectIncome (PR #367, MED-1):
 *   - same key twice → ONE row, second call returns the existing row.
 *   - different keys → independent rows.
 *   - concurrent duplicate submit that slips past the early-SELECT collides on
 *     the partial unique index (23505) → idempotent response, NOT a 500,
 *     still exactly ONE row.
 *   - missing key → Zod rejects (400 path).
 *
 * PLUS the money-path closure this task's defect report calls out explicitly:
 * createSeniorIncome/createDropIncome do NOT book a company obligation
 * themselves (unlike declareUsdtProjectIncome) — a SENIOR_INCOME/DROP_INCOME
 * row only turns into an obligation later, when an ACCOUNTANT validates it and
 * the SENIOR/DROP bundles their VALIDATED incomes into a payout request
 * (createPayoutRequest sums ALL bundled rows' amounts; for a drop-project the
 * pay cascade then books a senior IOU + a drop IOU off that sum via
 * bookCompanyObligations). A double-click that created TWO identical PENDING
 * rows would let an ACCOUNTANT validate both (they look identical — nothing
 * flags a duplicate) and the SENIOR/DROP bundle both into one payout,
 * DOUBLING incomeAmount/payableAmount and therefore the booked obligation.
 * The "closes the loop" tests below (AC5) drive a double-submit all the way
 * through validate → createPayoutRequest → manualConfirmPayout and assert the
 * booked drop/senior obligations reflect the SINGLE original income, not two —
 * proving the fix at the row-creation level is sufficient to prevent the
 * downstream doubling the task report describes, since createPayoutRequest can
 * only ever sum what physically exists as ONE row.
 *
 * Run against a scratch DB (NEVER the live crm_db):
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_qa \
 *     pnpm --filter @crm/api test -- senior-drop-income-idempotency.integration
 *
 * DB-SKIP-GUARD: skips when DATABASE_URL is unreachable or the
 * SENIOR_INCOME/DROP_INCOME partial unique indexes are not migrated (AC's
 * concurrent-race cases need them).
 */

const SENIOR: SessionUser = {
  id: 'a5310000-0000-4000-bb00-000000000001',
  email: 'sdi-senior@test.spec',
  displayName: 'SDI Senior',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}
const DROP: SessionUser = {
  ...SENIOR,
  id: 'a5310000-0000-4000-bb00-000000000002',
  email: 'sdi-drop@test.spec',
  displayName: 'SDI Drop',
  role: 'DROP',
}
const ADMIN_MAKSYM: SessionUser = {
  ...SENIOR,
  id: MAKSYM_ID,
  email: 'sdi-maksym@test.spec',
  displayName: 'SDI Maksym',
  role: 'ADMIN',
  seniorSharePercent: 0,
}

// Only SENIOR/DROP are THIS spec's own users — MAKSYM is the canonical admin
// and must never be blanket-deleted (would nuke seed/other-spec rows).
const TEST_OWN_USERS = [SENIOR, DROP]
const TEST_OWN_USER_IDS = TEST_OWN_USERS.map((u) => u.id)

// Variant nibble MUST be 8/9/a/b (Zod v4 `.uuid()` enforces RFC 4122 strictly,
// unlike some earlier fixture IDs elsewhere in this codebase that happen to
// only ever reach the service directly, bypassing schema validation) — these
// three are the only fixture ids in this file actually run through
// `createSeniorIncomeSchema.parse`/`createDropIncomeSchema.parse` below.
const SENIOR_PROJECT = 'a5310000-0000-4000-a100-000000000001'
const DROP_PROJECT = 'a5310000-0000-4000-a100-000000000002'
const MY_PROJECT_IDS = [SENIOR_PROJECT, DROP_PROJECT]

const ACCOUNT_ID = 'a5310000-0000-4000-a200-000000000001'
const WALLET = '0xA53100000000000000000000000000000000ab'
const DROP_SHARE = 5

const fakeNbu: Pick<NbuCurrencyService, 'getRates'> = {
  getRates: () =>
    Promise.resolve({ usdUah: '40.0000', usdtUah: '40.0000', eurUah: '44.0000', date: '20260620' }),
}
const stubEtherscan = {} as unknown as EtherscanService
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
          etherscanService: stubEtherscan,
        }),
      inject: [DatabaseService],
    },
  ],
})
class SeniorDropIdemTestModule {}

describe.skipIf(!hasDatabaseUrl())(
  'createSeniorIncome/createDropIncome idempotency (real DB, backlog 73/A-3)',
  () => {
    let svc: TransactionsService
    let dbSvc: DatabaseService

    // Surgical cleanup — never a blanket delete by MAKSYM id.
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

    async function obligationsFor(
      creditorId: string,
    ): Promise<{ id: string; amount: string; debtorType: string }[]> {
      return dbSvc.db
        .select({
          id: pendingObligations.id,
          amount: pendingObligations.amount,
          debtorType: pendingObligations.debtorType,
        })
        .from(pendingObligations)
        .where(eq(pendingObligations.creditorUserId, creditorId))
    }

    beforeAll(async () => {
      try {
        const probe = new Pool({ connectionString: process.env['DATABASE_URL'] })
        await probe.query('SELECT 1')
        const colOk = await probe.query(
          `SELECT 1 FROM information_schema.columns
           WHERE table_name='transactions' AND column_name='idempotency_key' LIMIT 1`,
        )
        const seniorIdxOk = await probe.query(
          `SELECT 1 FROM pg_indexes
           WHERE indexname='uq_transactions_senior_income_idempotency_key' LIMIT 1`,
        )
        const dropIdxOk = await probe.query(
          `SELECT 1 FROM pg_indexes
           WHERE indexname='uq_transactions_drop_income_idempotency_key' LIMIT 1`,
        )
        await probe.end()
        if (colOk.rowCount === 0 || seniorIdxOk.rowCount === 0 || dropIdxOk.rowCount === 0) {
          throw new Error(
            '[senior-drop-income-idempotency] FAILED — idempotency_key column / SENIOR_INCOME / DROP_INCOME partial unique indexes not migrated',
          )
        }
      } catch {
        throw new Error('[senior-drop-income-idempotency] FAILED — no DB reachable at DATABASE_URL')
      }

      const moduleRef = await Test.createTestingModule({
        imports: [SeniorDropIdemTestModule],
      }).compile()
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
          TEST_OWN_USERS.map((u) => ({
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

      // FOP projects (paymentType defaults to 'FOP') — SENIOR_INCOME/DROP_INCOME
      // are only reachable on a non-USDT project.
      await db
        .insert(projects)
        .values([
          {
            id: SENIOR_PROJECT,
            name: 'SDI Senior Project',
            companyName: 'SDI SeniorCorp',
            domain: 'ai',
            startDate: new Date('2025-01-01'),
            seniorId: SENIOR.id,
            dropId: null,
            currency: 'USD',
            rate: 1000,
          },
          {
            id: DROP_PROJECT,
            name: 'SDI Drop Project',
            companyName: 'SDI DropCorp',
            domain: 'fintech',
            startDate: new Date('2025-01-01'),
            seniorId: SENIOR.id,
            dropId: DROP.id,
            currency: 'USD',
            rate: 1000,
          },
        ])
        .onConflictDoNothing()

      // Company wallet — createPayoutRequest refuses to book a payout without one.
      const existing = await db.query.companyAccount.findFirst()
      if (!existing) {
        await db.insert(companyAccount).values({ id: ACCOUNT_ID, walletAddress: WALLET })
      } else if (!existing.walletAddress) {
        await db.update(companyAccount).set({ walletAddress: WALLET })
      }
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

    // ── createSeniorIncome ──────────────────────────────────────────────────

    it('SENIOR: same key twice → ONE SENIOR_INCOME row, second call returns existing', async () => {
      const key = randomUUID()
      const first = await svc.createSeniorIncome(
        {
          projectId: SENIOR_PROJECT,
          amount: 1000,
          currency: 'USD',
          idempotencyKey: key,
          receiptExternalUrl: 'https://example.com/receipt-1',
        },
        SENIOR,
      )
      const second = await svc.createSeniorIncome(
        {
          projectId: SENIOR_PROJECT,
          amount: 1000,
          currency: 'USD',
          idempotencyKey: key,
          receiptExternalUrl: 'https://example.com/receipt-1',
        },
        SENIOR,
      )
      expect(second.id).toBe(first.id)
      expect(await countTxType('SENIOR_INCOME', SENIOR_PROJECT)).toBe(1)
    }, 30_000)

    it('SENIOR: two different keys → TWO independent rows', async () => {
      await svc.createSeniorIncome(
        {
          projectId: SENIOR_PROJECT,
          amount: 1000,
          currency: 'USD',
          idempotencyKey: randomUUID(),
          receiptExternalUrl: 'https://example.com/receipt-1',
        },
        SENIOR,
      )
      await svc.createSeniorIncome(
        {
          projectId: SENIOR_PROJECT,
          amount: 1000,
          currency: 'USD',
          idempotencyKey: randomUUID(),
          receiptExternalUrl: 'https://example.com/receipt-1',
        },
        SENIOR,
      )
      expect(await countTxType('SENIOR_INCOME', SENIOR_PROJECT)).toBe(2)
    }, 30_000)

    // ── AC5 (race): concurrent duplicate submit collides on the unique index ──
    it('SENIOR: concurrent duplicate submit (same key) → both fulfilled with SAME id, exactly ONE row (no 500)', async () => {
      const key = randomUUID()
      const results = await Promise.allSettled([
        svc.createSeniorIncome(
          {
            projectId: SENIOR_PROJECT,
            amount: 1000,
            currency: 'USD',
            idempotencyKey: key,
            receiptExternalUrl: 'https://example.com/receipt-1',
          },
          SENIOR,
        ),
        svc.createSeniorIncome(
          {
            projectId: SENIOR_PROJECT,
            amount: 1000,
            currency: 'USD',
            idempotencyKey: key,
            receiptExternalUrl: 'https://example.com/receipt-1',
          },
          SENIOR,
        ),
      ])

      expect(results[0]!.status).toBe('fulfilled')
      expect(results[1]!.status).toBe('fulfilled')
      const ids = results
        .filter((r): r is PromiseFulfilledResult<{ id: string }> => r.status === 'fulfilled')
        .map((r) => r.value.id)
      expect(ids[0]).toBe(ids[1])
      expect(await countTxType('SENIOR_INCOME', SENIOR_PROJECT)).toBe(1)
    }, 30_000)

    // ── createDropIncome ────────────────────────────────────────────────────

    it('DROP: same key twice → ONE DROP_INCOME row, second call returns existing', async () => {
      const key = randomUUID()
      const first = await svc.createDropIncome(
        {
          projectId: DROP_PROJECT,
          amount: 1000,
          currency: 'USD',
          idempotencyKey: key,
          receiptExternalUrl: 'https://example.com/receipt-2',
        },
        DROP,
      )
      const second = await svc.createDropIncome(
        {
          projectId: DROP_PROJECT,
          amount: 1000,
          currency: 'USD',
          idempotencyKey: key,
          receiptExternalUrl: 'https://example.com/receipt-2',
        },
        DROP,
      )
      expect(second.id).toBe(first.id)
      expect(await countTxType('DROP_INCOME', DROP_PROJECT)).toBe(1)
    }, 30_000)

    it('DROP: two different keys → TWO independent rows', async () => {
      await svc.createDropIncome(
        {
          projectId: DROP_PROJECT,
          amount: 1000,
          currency: 'USD',
          idempotencyKey: randomUUID(),
          receiptExternalUrl: 'https://example.com/receipt-2',
        },
        DROP,
      )
      await svc.createDropIncome(
        {
          projectId: DROP_PROJECT,
          amount: 1000,
          currency: 'USD',
          idempotencyKey: randomUUID(),
          receiptExternalUrl: 'https://example.com/receipt-2',
        },
        DROP,
      )
      expect(await countTxType('DROP_INCOME', DROP_PROJECT)).toBe(2)
    }, 30_000)

    it('DROP: concurrent duplicate submit (same key) → both fulfilled with SAME id, exactly ONE row (no 500)', async () => {
      const key = randomUUID()
      const results = await Promise.allSettled([
        svc.createDropIncome(
          {
            projectId: DROP_PROJECT,
            amount: 1000,
            currency: 'USD',
            idempotencyKey: key,
            receiptExternalUrl: 'https://example.com/receipt-2',
          },
          DROP,
        ),
        svc.createDropIncome(
          {
            projectId: DROP_PROJECT,
            amount: 1000,
            currency: 'USD',
            idempotencyKey: key,
            receiptExternalUrl: 'https://example.com/receipt-2',
          },
          DROP,
        ),
      ])

      expect(results[0]!.status).toBe('fulfilled')
      expect(results[1]!.status).toBe('fulfilled')
      const ids = results
        .filter((r): r is PromiseFulfilledResult<{ id: string }> => r.status === 'fulfilled')
        .map((r) => r.value.id)
      expect(ids[0]).toBe(ids[1])
      expect(await countTxType('DROP_INCOME', DROP_PROJECT)).toBe(1)
    }, 30_000)

    // ── AC3 (schema): missing idempotencyKey → Zod rejects (400 path) ─────────
    it('missing idempotencyKey → Zod rejects on both schemas (400 path, no DB needed)', () => {
      const seniorBase = {
        projectId: SENIOR_PROJECT,
        amount: 100,
        currency: 'USD',
        receiptExternalUrl: 'https://example.com/receipt-1',
      }
      expect(() => createSeniorIncomeSchema.parse(seniorBase)).toThrow()
      expect(() =>
        createSeniorIncomeSchema.parse({ ...seniorBase, idempotencyKey: 'not-a-uuid' }),
      ).toThrow()
      expect(() =>
        createSeniorIncomeSchema.parse({ ...seniorBase, idempotencyKey: randomUUID() }),
      ).not.toThrow()

      const dropBase = {
        projectId: DROP_PROJECT,
        amount: 100,
        currency: 'USD',
        receiptExternalUrl: 'https://example.com/receipt-2',
      }
      expect(() => createDropIncomeSchema.parse(dropBase)).toThrow()
      expect(() =>
        createDropIncomeSchema.parse({ ...dropBase, idempotencyKey: 'not-a-uuid' }),
      ).toThrow()
      expect(() =>
        createDropIncomeSchema.parse({ ...dropBase, idempotencyKey: randomUUID() }),
      ).not.toThrow()
    })

    // ── AC5 (money-path closure): double-submit → validate → payout → confirm ──
    // Drives the ORIGINAL defect report end to end: a double-click that used to
    // create two DROP_INCOME rows would let an ACCOUNTANT validate both and the
    // DROP bundle both into one payout request, doubling the amount
    // createPayoutRequest sums and therefore the senior/drop obligations
    // bookCompanyObligations books off it. With the fix there is only ever ONE
    // row to validate/bundle, so the obligations booked at the end of the
    // cascade reflect the SINGLE original income — proven here by driving the
    // real cascade (not asserting createDropIncome in isolation).
    it('DROP: double-submit (same key) survives validate → payout → confirm with obligations NOT doubled', async () => {
      const key = randomUUID()
      const amount = 1000

      // The "double click" — two calls, same key. Fix collapses to one row.
      const first = await svc.createDropIncome(
        {
          projectId: DROP_PROJECT,
          amount,
          currency: 'USD',
          idempotencyKey: key,
          receiptExternalUrl: 'https://example.com/receipt-2',
        },
        DROP,
      )
      const second = await svc.createDropIncome(
        {
          projectId: DROP_PROJECT,
          amount,
          currency: 'USD',
          idempotencyKey: key,
          receiptExternalUrl: 'https://example.com/receipt-2',
        },
        DROP,
      )
      expect(second.id).toBe(first.id)
      expect(await countTxType('DROP_INCOME', DROP_PROJECT)).toBe(1)

      // ACCOUNTANT-equivalent step: validate the ONE row (ADMIN may validate too).
      await svc.validateTransaction(first.id, 'validate', undefined, ADMIN_MAKSYM)

      // DROP bundles their (single) VALIDATED income into a payout request.
      const pr = await svc.createPayoutRequest([first.id], DROP)
      // incomeAmount is the SUM of every bundled row — must equal the ORIGINAL
      // amount, not 2x (the exact quantity that would have been wrong under the
      // pre-fix double-row bug).
      expect(parseFloat(pr.incomeAmount)).toBeCloseTo(amount, 5)

      // ADMIN confirms the payout off-platform (no on-chain hash needed for
      // COMPANY_ACCOUNT — manualConfirmPayout synthesizes a 0xMANUAL marker).
      await svc.manualConfirmPayout(pr.id, 'COMPANY_ACCOUNT', ADMIN_MAKSYM, {})

      // Exactly ONE senior IOU + ONE drop IOU — not two — and their amounts are
      // priced off the single, undoubled income.
      const seniorObls = await obligationsFor(SENIOR.id)
      const dropObls = await obligationsFor(DROP.id)
      expect(seniorObls).toHaveLength(1)
      expect(dropObls).toHaveLength(1)
      // Senior share (26%) + drop share (5%) of the ORIGINAL 1000 — would be
      // exactly double if the pre-fix bug had let both rows through.
      expect(parseFloat(seniorObls[0]!.amount)).toBeCloseTo(amount * 0.26, 5)
      expect(parseFloat(dropObls[0]!.amount)).toBeCloseTo(amount * 0.05, 5)
    }, 30_000)
  },
)
