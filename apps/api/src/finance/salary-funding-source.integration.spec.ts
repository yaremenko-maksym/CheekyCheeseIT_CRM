import { Global, Module } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { drizzle } from 'drizzle-orm/node-postgres'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'

import { DatabaseService } from '../database/database.service'
import { TransactionsService } from './transactions.service'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'
import { computeCompanyAccountBalanceFromLedger } from './company-account-balance'
import { transactions, users } from '../database/schema'
import * as schema from '../database/schema'
import { hasDatabaseUrl } from '../test/require-real-db'

/**
 * task-salary-pay-flow — salary funding source moved from CREATE to PAY (real DB).
 *
 * Asserts, against REAL PostgreSQL:
 *   - createSalary creates a NEUTRAL PENDING reminder: status PENDING,
 *     funding_source NULL, sender NULL, NO balance gate (no funding at creation).
 *   - paySalary COMPANY_ACCOUNT → currency forced USDT, funding_source persisted,
 *     senderLabel «Счёт компании», txDate stamped at pay; balance gate throws
 *     when the company account is short; with funds it DEBITS the company balance.
 *   - paySalary ADMIN_PERSONAL → PAID with the CHOSEN currency, sender = payer
 *     admin, company balance UNCHANGED; a non-ADMIN payerAdminId → BadRequest.
 *   - #222 invariant preserved: ADMIN receiver still rejected at createSalary.
 *
 * Invoices/documents collaborators are stubbed (salary auto-invoice is
 * best-effort and irrelevant to funding-source logic).
 *
 * Run against a scratch DB (NEVER the live crm_db):
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_qa \
 *     pnpm --filter @crm/api test -- salary-funding-source.integration
 */

const ADMIN: SessionUser = {
  id: 'fa110000-0000-4000-aa00-000000000001',
  email: 'fs-admin@test.spec',
  displayName: 'FS Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 26,
  legalFullName: null,
}
const ADMIN2: SessionUser = {
  ...ADMIN,
  id: 'fa110000-0000-4000-aa00-000000000002',
  email: 'fs-admin2@test.spec',
  displayName: 'FS Admin Two',
}
const JUNIOR: SessionUser = {
  ...ADMIN,
  id: 'fa110000-0000-4000-aa00-000000000003',
  email: 'fs-junior@test.spec',
  displayName: 'FS Junior',
  role: 'JUNIOR',
  seniorSharePercent: 0,
}
const SENIOR: SessionUser = {
  ...ADMIN,
  id: 'fa110000-0000-4000-aa00-000000000004',
  email: 'fs-senior@test.spec',
  displayName: 'FS Senior',
  role: 'SENIOR',
}

const ALL = [ADMIN, ADMIN2, JUNIOR, SENIOR]
const TEST_USER_IDS = ALL.map((u) => u.id)
// Namespaced deposit row so the company balance is deterministic for THIS spec.
const DEPOSIT_ID = 'fa110000-0000-4000-cc00-000000000001'

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
      useFactory: (db: DatabaseService) => makeTransactionsService({ db }),
      inject: [DatabaseService],
    },
  ],
})
class FundingSourceTestModule {}

describe.skipIf(!hasDatabaseUrl())(
  'salary funding source: create → pay (real DB, no mocks) — task-salary-pay-flow',
  () => {
    let svc: TransactionsService
    let dbSvc: DatabaseService

    // Clean every SALARY/COMPANY_DEPOSIT row authored by our personas + the
    // namespaced deposit so the company balance is fully deterministic.
    async function cleanup() {
      const db = dbSvc.db
      await db.delete(transactions).where(inArray(transactions.createdBy, TEST_USER_IDS))
      await db.delete(transactions).where(inArray(transactions.id, [DEPOSIT_ID]))
    }

    beforeAll(async () => {
      try {
        const probe = new Pool({ connectionString: process.env['DATABASE_URL'] })
        await probe.query('SELECT 1')
        const check = await probe.query(
          `SELECT column_name FROM information_schema.columns WHERE table_name='transactions' AND column_name='funding_source' LIMIT 1`,
        )
        await probe.end()
        if (check.rowCount === 0) {
          throw new Error('[salary-funding-source] FAILED — funding_source column not found')
        }
      } catch {
        throw new Error('[salary-funding-source] FAILED — no DB reachable at DATABASE_URL')
      }

      const moduleRef = await Test.createTestingModule({
        imports: [FundingSourceTestModule],
      }).compile()
      await moduleRef.init()
      svc = moduleRef.get(TransactionsService)
      dbSvc = moduleRef.get(DatabaseService)

      const db = dbSvc.db
      await cleanup()
      await db.delete(users).where(inArray(users.id, TEST_USER_IDS))
      await db
        .insert(users)
        .values(
          ALL.map((u) => ({
            id: u.id,
            email: u.email,
            displayName: u.displayName,
            role: u.role,
            googleId: `test-google-${u.id}`,
          })),
        )
        .onConflictDoNothing()
    }, 30_000)

    afterAll(async () => {
      try {
        await cleanup()
        await dbSvc.db.delete(users).where(inArray(users.id, TEST_USER_IDS))
      } catch {
        // non-fatal
      }
      await _pool?.end()
    }, 15_000)

    // Helper: seed a confirmed company deposit so the balance covers `amount`.
    async function seedCompanyDeposit(amount: number) {
      await dbSvc.db.insert(transactions).values({
        id: DEPOSIT_ID,
        type: 'COMPANY_DEPOSIT',
        status: 'PAID',
        amount: String(amount),
        currency: 'USDT',
        senderId: SENIOR.id,
        createdBy: SENIOR.id,
      })
    }

    // The company balance is a GLOBAL ledger aggregate (it sums every
    // company-funded row in the DB, not just this spec's), so the scratch crm_qa
    // may carry a non-zero residual balance. Read it live and size amounts
    // relative to it rather than assuming an isolated 0.
    async function liveBalance(): Promise<number> {
      return computeCompanyAccountBalanceFromLedger(dbSvc.db)
    }

    // Scoped contribution = the 6-term company-account balance restricted to rows
    // authored by THIS spec's personas. Lets us assert balance deltas
    // deterministically even though the underlying balance is a GLOBAL aggregate
    // that parallel spec files mutate concurrently.
    async function myContribution(): Promise<number> {
      const sumByType = async (type: string, companyOnly: boolean): Promise<number> => {
        const conds = [
          eq(transactions.type, type as never),
          eq(transactions.status, 'PAID' as never),
          inArray(transactions.createdBy, [ADMIN.id, ADMIN2.id, JUNIOR.id, SENIOR.id]),
          ...(companyOnly ? [eq(transactions.fundingSource, 'COMPANY_ACCOUNT' as never)] : []),
        ]
        const rows = await dbSvc.db
          .select({ total: sql<string>`COALESCE(SUM(${transactions.amount}), 0)` })
          .from(transactions)
          .where(and(...conds))
        const total = parseFloat(rows[0]?.total ?? '0')
        return Number.isFinite(total) ? total : 0
      }
      const [deposits, salary] = await Promise.all([
        sumByType('COMPANY_DEPOSIT', false),
        sumByType('SALARY', true),
      ])
      return deposits - salary
    }

    // ── AC1: createSalary = neutral PENDING reminder ───────────────────────────

    it('createSalary → PENDING reminder: funding_source null, sender null, NO balance gate', async () => {
      await cleanup()
      // No company deposit seeded — createSalary must NOT gate on the balance now.
      const tx = await svc.createSalary(
        { receiverId: JUNIOR.id, amount: 400, currency: 'USD', salaryMonth: '2026-06' },
        ADMIN,
      )
      expect(tx.status).toBe('PENDING')
      expect(tx.senderId).toBeNull()
      // Nominal currency is preserved (no USDT-force at creation).
      expect(tx.currency).toBe('USD')
      const row = await dbSvc.db.query.transactions.findFirst({ where: eq(transactions.id, tx.id) })
      expect((row as { fundingSource?: string | null }).fundingSource).toBeNull()
    })

    it('createSalary does not require company funds even when balance is zero/short', async () => {
      await cleanup()
      // Far more than the live balance — under the old contract this gated; now it
      // must succeed (no funding source chosen at creation).
      const big = (await liveBalance()) + 1_000_000
      const tx = await svc.createSalary(
        { receiverId: JUNIOR.id, amount: big, salaryMonth: '2026-06' },
        ADMIN,
      )
      expect(tx.status).toBe('PENDING')
    })

    // ── AC2: paySalary COMPANY_ACCOUNT ─────────────────────────────────────────

    it('paySalary COMPANY_ACCOUNT → USDT forced, sender label «Счёт компании», debits balance', async () => {
      await cleanup()
      await seedCompanyDeposit(1000)
      const before = await myContribution() // +1000 deposit, 0 salary
      const pending = await svc.createSalary(
        { receiverId: JUNIOR.id, amount: 600, currency: 'USD', salaryMonth: '2026-06' },
        ADMIN,
      )
      // Pay it from the company account. A non-USDT currency is overridden to USDT.
      // task-receipts-backend (review round 1): pay-time proof now MANDATORY
      // (COMPANY_ACCOUNT → USDT → explorer-only).
      const paid = await svc.paySalary(
        pending.id,
        {
          fundingSource: 'COMPANY_ACCOUNT',
          currency: 'UAH',
          receiptExternalUrl: 'https://etherscan.io/tx/0xsalaryfundingsourcespec1',
        },
        ADMIN,
      )
      expect(paid.status).toBe('PAID')
      expect(paid.currency).toBe('USDT')
      expect(paid.senderId).toBeNull()
      const row = await dbSvc.db.query.transactions.findFirst({
        where: eq(transactions.id, pending.id),
      })
      expect((row as { fundingSource?: string | null }).fundingSource).toBe('COMPANY_ACCOUNT')
      expect((row as { senderLabel?: string | null }).senderLabel).toBe('Счёт компании')
      // txDate is stamped at pay time (non-null).
      expect((row as { txDate?: Date | null }).txDate).not.toBeNull()
      // The PAID company salary is counted by the balance formula → contribution
      // drops by exactly the salary amount.
      expect(await myContribution()).toBe(before - 600)
    })

    it('paySalary COMPANY_ACCOUNT with insufficient balance → BadRequest, stays PENDING', async () => {
      await cleanup()
      // No deposit → ask for far more than the live balance so the gate trips.
      const tooMuch = (await liveBalance()) + 1_000_000
      const pending = await svc.createSalary(
        { receiverId: JUNIOR.id, amount: tooMuch, salaryMonth: '2026-06' },
        ADMIN,
      )
      await expect(
        svc.paySalary(
          pending.id,
          {
            fundingSource: 'COMPANY_ACCOUNT',
            currency: 'USDT',
            receiptExternalUrl: 'https://etherscan.io/tx/0xsalaryfundingsourcespec2',
          },
          ADMIN,
        ),
      ).rejects.toThrowError(/Недостаточно средств/)
      const row = await dbSvc.db.query.transactions.findFirst({
        where: eq(transactions.id, pending.id),
      })
      expect((row as { status?: string }).status).toBe('PENDING')
    })

    // ── AC3: paySalary ADMIN_PERSONAL ──────────────────────────────────────────

    it('paySalary ADMIN_PERSONAL → PAID with chosen currency, sender = payer, company balance UNCHANGED', async () => {
      await cleanup()
      await seedCompanyDeposit(1000)
      const before = await myContribution()
      const pending = await svc.createSalary(
        { receiverId: SENIOR.id, amount: 100, currency: 'USD', salaryMonth: '2026-06' },
        ADMIN,
      )
      // task-receipts-backend (review round 1): pay-time proof now MANDATORY.
      const paid = await svc.paySalary(
        pending.id,
        {
          fundingSource: 'ADMIN_PERSONAL',
          payerAdminId: ADMIN2.id,
          currency: 'UAH',
          receiptExternalUrl: 'https://drive.google.com/file/salaryfundingsourcespec3',
        },
        ADMIN,
      )
      expect(paid.status).toBe('PAID')
      expect(paid.senderId).toBe(ADMIN2.id)
      // ADMIN_PERSONAL preserves the chosen currency (any allowed).
      expect(paid.currency).toBe('UAH')
      const row = await dbSvc.db.query.transactions.findFirst({
        where: eq(transactions.id, pending.id),
      })
      expect((row as { fundingSource?: string | null }).fundingSource).toBe('ADMIN_PERSONAL')
      // A personal payout NEVER debits the company balance.
      expect(await myContribution()).toBe(before)
    })

    it('paySalary ADMIN_PERSONAL with a NON-ADMIN payerAdminId → BadRequest', async () => {
      await cleanup()
      const pending = await svc.createSalary(
        { receiverId: SENIOR.id, amount: 100, salaryMonth: '2026-06' },
        ADMIN,
      )
      await expect(
        svc.paySalary(
          pending.id,
          {
            fundingSource: 'ADMIN_PERSONAL',
            payerAdminId: JUNIOR.id,
            currency: 'USD',
            receiptExternalUrl: 'https://drive.google.com/file/salaryfundingsourcespec4',
          },
          ADMIN,
        ),
      ).rejects.toThrowError(/ADMIN/)
    })

    // ── #222 invariant preserved at creation ───────────────────────────────────

    it('#222 invariant preserved: ADMIN receiver rejected at createSalary', async () => {
      await cleanup()
      await expect(
        svc.createSalary({ receiverId: ADMIN2.id, amount: 100, salaryMonth: '2026-06' }, ADMIN),
      ).rejects.toThrowError(/ADMIN не получает зарплату/)
    })

    it('sanity: company-funded rows are queryable by funding_source filter', async () => {
      const rows = await dbSvc.db
        .select({ id: transactions.id })
        .from(transactions)
        .where(
          and(eq(transactions.type, 'SALARY'), eq(transactions.fundingSource, 'COMPANY_ACCOUNT')),
        )
      expect(Array.isArray(rows)).toBe(true)
    })
  },
)
