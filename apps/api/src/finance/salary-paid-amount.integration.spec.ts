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
import { transactions, users } from '../database/schema'
import * as schema from '../database/schema'

/**
 * task-salary-pay-amount — paying a salary with a hand-entered amount (real DB).
 *
 * Asserts, against REAL PostgreSQL:
 *   AC3  The obligation is closed IN FULL by whatever amount is paid — there
 *        are no partial payments in this model, so the row reaches PAID
 *        regardless of how far the figure is from the rate-derived expectation.
 *   AC4  The obligation is NOT lost. `amount`/`currency` carry the FACT of the
 *        payment (so a bank statement reconciles one-to-one) while
 *        original_amount / original_currency / exchange_rate preserve what was
 *        owed — read back BOTH from the raw row and from the API DTO, because
 *        an unmapped column is just as lost as an unwritten one.
 *   AC6  Money that reads transaction amounts keeps behaving: the
 *        company-account balance debits by what was ACTUALLY paid, the gate
 *        measures that same figure (the regression that would otherwise let a
 *        payout exceed the balance), and a legacy call without `paidAmount`
 *        leaves `amount` byte-for-byte untouched.
 *
 * Invoices/documents collaborators are stubbed (the salary auto-invoice is
 * best-effort and irrelevant here).
 *
 * Run against a scratch DB (NEVER the live crm_db):
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_scratch_paidamount \
 *     pnpm --filter @crm/api test -- salary-paid-amount.integration
 */

const ADMIN: SessionUser = {
  id: 'fa220000-0000-4000-aa00-000000000001',
  email: 'pa-admin@test.spec',
  displayName: 'PA Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 26,
  legalFullName: null,
}
const JUNIOR: SessionUser = {
  ...ADMIN,
  id: 'fa220000-0000-4000-aa00-000000000002',
  email: 'pa-junior@test.spec',
  displayName: 'PA Junior',
  role: 'JUNIOR',
  seniorSharePercent: 0,
}
const SENIOR: SessionUser = {
  ...ADMIN,
  id: 'fa220000-0000-4000-aa00-000000000003',
  email: 'pa-senior@test.spec',
  displayName: 'PA Senior',
  role: 'SENIOR',
}

const ALL = [ADMIN, JUNIOR, SENIOR]
const TEST_USER_IDS = ALL.map((u) => u.id)
const DEPOSIT_ID = 'fa220000-0000-4000-cc00-000000000001'

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
      useFactory: (db: DatabaseService) => makeTransactionsService({ db }),
      inject: [DatabaseService],
    },
  ],
})
class PaidAmountTestModule {}

const RECEIPT = 'https://etherscan.io/tx/0xsalarypaidamountspec'

describe('salary pay-time amount: fact vs obligation (real DB) — task-salary-pay-amount', () => {
  let svc: TransactionsService
  let dbSvc: DatabaseService

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
        `SELECT column_name FROM information_schema.columns WHERE table_name='transactions' AND column_name='original_amount' LIMIT 1`,
      )
      await probe.end()
      if (check.rowCount === 0) {
        console.warn(
          '[salary-paid-amount] SKIPPED — original_amount column not found (run db:push)',
        )
        dbAvailable = false
        return
      }
    } catch {
      console.warn('[salary-paid-amount] SKIPPED — no DB reachable at DATABASE_URL')
      dbAvailable = false
      return
    }

    const moduleRef = await Test.createTestingModule({ imports: [PaidAmountTestModule] }).compile()
    await moduleRef.init()
    svc = moduleRef.get(TransactionsService)
    dbSvc = moduleRef.get(DatabaseService)

    await cleanup()
    await dbSvc.db.delete(users).where(inArray(users.id, TEST_USER_IDS))
    await dbSvc.db
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
    if (!dbAvailable) return
    try {
      await cleanup()
      await dbSvc.db.delete(users).where(inArray(users.id, TEST_USER_IDS))
    } catch {
      // non-fatal
    }
    await _pool?.end()
  }, 15_000)

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

  /**
   * The company balance is a GLOBAL ledger aggregate, so a scratch DB shared
   * with other specs can carry a residual. Measure only THIS spec's personas'
   * contribution (deposits − company-funded salary) to assert deltas.
   */
  async function myContribution(): Promise<number> {
    const sumByType = async (type: string, companyOnly: boolean): Promise<number> => {
      const rows = await dbSvc.db
        .select({ total: sql<string>`COALESCE(SUM(${transactions.amount}), 0)` })
        .from(transactions)
        .where(
          and(
            eq(transactions.type, type as never),
            eq(transactions.status, 'PAID' as never),
            inArray(transactions.createdBy, TEST_USER_IDS),
            ...(companyOnly ? [eq(transactions.fundingSource, 'COMPANY_ACCOUNT' as never)] : []),
          ),
        )
      const total = parseFloat(rows[0]?.total ?? '0')
      return Number.isFinite(total) ? total : 0
    }
    const [deposits, salary] = await Promise.all([
      sumByType('COMPANY_DEPOSIT', false),
      sumByType('SALARY', true),
    ])
    return deposits - salary
  }

  function rawRow(id: string) {
    return dbSvc.db.query.transactions.findFirst({ where: eq(transactions.id, id) })
  }

  // ── AC3 + AC4 — the headline case: 800 USD owed, 30 000 UAH actually paid ──

  it('closes the obligation in full and keeps BOTH the fact and the obligation', async () => {
    if (!dbAvailable) return
    await cleanup()
    const pending = await svc.createSalary(
      { receiverId: JUNIOR.id, amount: 800, currency: 'USD', salaryMonth: '2026-08' },
      ADMIN,
    )

    const paid = await svc.paySalary(
      pending.id,
      {
        fundingSource: 'ADMIN_PERSONAL',
        payerAdminId: ADMIN.id,
        currency: 'UAH',
        paidAmount: 30_000,
        receiptExternalUrl: `${RECEIPT}1`,
      },
      ADMIN,
    )

    // AC3 — fully closed, no partial state, no matter the figure.
    expect(paid.status).toBe('PAID')

    // The FACT of the payment is what the row now carries (bank reconciliation).
    expect(parseFloat(paid.amount)).toBe(30_000)
    expect(paid.currency).toBe('UAH')

    // AC4 — the obligation survived, in the DTO…
    expect(parseFloat(paid.originalAmount!)).toBe(800)
    expect(paid.originalCurrency).toBe('USD')
    expect(parseFloat(paid.exchangeRate!)).toBeCloseTo(37.5, 6)

    // …and in the row itself.
    const row = (await rawRow(pending.id))!
    expect(parseFloat(row.amount)).toBe(30_000)
    expect(row.currency).toBe('UAH')
    expect(parseFloat(row.originalAmount!)).toBe(800)
    expect(row.originalCurrency).toBe('USD')
    expect(parseFloat(row.exchangeRate!)).toBeCloseTo(37.5, 6)
  })

  it('re-reading the transaction later still returns the obligation (AC4, read path)', async () => {
    if (!dbAvailable) return
    await cleanup()
    const pending = await svc.createSalary(
      { receiverId: JUNIOR.id, amount: 800, currency: 'USD', salaryMonth: '2026-08' },
      ADMIN,
    )
    await svc.paySalary(
      pending.id,
      {
        fundingSource: 'ADMIN_PERSONAL',
        payerAdminId: ADMIN.id,
        currency: 'UAH',
        paidAmount: 30_000,
        receiptExternalUrl: `${RECEIPT}2`,
      },
      ADMIN,
    )

    // A fresh read through the SAME mapper the API uses — an obligation that
    // only exists in the DB but never reaches the client is still lost.
    const fetched = await svc.findOne(pending.id, ADMIN)
    expect(parseFloat(fetched.amount)).toBe(30_000)
    expect(parseFloat(fetched.originalAmount!)).toBe(800)
    expect(fetched.originalCurrency).toBe('USD')
    expect(parseFloat(fetched.exchangeRate!)).toBeCloseTo(37.5, 6)
  })

  it('a wildly implausible amount still closes the obligation (no server-side plausibility gate)', async () => {
    if (!dbAvailable) return
    await cleanup()
    const pending = await svc.createSalary(
      { receiverId: JUNIOR.id, amount: 800, currency: 'USD', salaryMonth: '2026-08' },
      ADMIN,
    )
    // 300 instead of 30 000 — the client WARNS about this; the server, by
    // design, does not refuse it (the owner may know something we do not).
    const paid = await svc.paySalary(
      pending.id,
      {
        fundingSource: 'ADMIN_PERSONAL',
        payerAdminId: ADMIN.id,
        currency: 'UAH',
        paidAmount: 300,
        receiptExternalUrl: `${RECEIPT}3`,
      },
      ADMIN,
    )
    expect(paid.status).toBe('PAID')
    expect(parseFloat(paid.amount)).toBe(300)
    // …and the obligation is still there to see what actually happened.
    expect(parseFloat(paid.originalAmount!)).toBe(800)
    expect(parseFloat(paid.exchangeRate!)).toBeCloseTo(0.375, 6)
  })

  // ── AC6 — backward compatibility of existing behaviour ─────────────────────

  it('a call WITHOUT paidAmount leaves `amount` untouched (legacy contract)', async () => {
    if (!dbAvailable) return
    await cleanup()
    const pending = await svc.createSalary(
      { receiverId: JUNIOR.id, amount: 750, currency: 'USD', salaryMonth: '2026-08' },
      ADMIN,
    )
    const before = (await rawRow(pending.id))!.amount

    const paid = await svc.paySalary(
      pending.id,
      {
        fundingSource: 'ADMIN_PERSONAL',
        payerAdminId: ADMIN.id,
        currency: 'UAH',
        receiptExternalUrl: `${RECEIPT}4`,
      },
      ADMIN,
    )

    // Byte-for-byte the same stored numeric string — not even re-serialised.
    const after = (await rawRow(pending.id))!
    expect(after.amount).toBe(before)
    expect(paid.currency).toBe('UAH')
    // The obligation snapshot is still stamped, so every paid row is uniform.
    expect(parseFloat(after.originalAmount!)).toBe(750)
    expect(after.originalCurrency).toBe('USD')
    expect(parseFloat(after.exchangeRate!)).toBe(1)
  })

  it('rejects a non-positive paid amount at the service boundary (defense in depth)', async () => {
    if (!dbAvailable) return
    await cleanup()
    const pending = await svc.createSalary(
      { receiverId: JUNIOR.id, amount: 500, currency: 'USD', salaryMonth: '2026-08' },
      ADMIN,
    )
    await expect(
      svc.paySalary(
        pending.id,
        {
          fundingSource: 'ADMIN_PERSONAL',
          payerAdminId: ADMIN.id,
          currency: 'UAH',
          paidAmount: 0,
          receiptExternalUrl: `${RECEIPT}5`,
        },
        ADMIN,
      ),
    ).rejects.toThrow()
    // Still PENDING — a refused payment must not half-close the obligation.
    expect((await rawRow(pending.id))!.status).toBe('PENDING')
  })

  // ── AC6 — the company-account gate must measure the amount being debited ───

  it('the company-account gate is measured on the PAID amount, not the obligation', async () => {
    if (!dbAvailable) return
    await cleanup()
    await seedCompanyDeposit(1000)
    // Obligation is small; the amount actually being sent is far larger than the
    // balance. Gating on the obligation (the pre-task behaviour) would have let
    // this through and driven the company account negative.
    const pending = await svc.createSalary(
      { receiverId: JUNIOR.id, amount: 100, currency: 'USD', salaryMonth: '2026-08' },
      ADMIN,
    )
    await expect(
      svc.paySalary(
        pending.id,
        {
          fundingSource: 'COMPANY_ACCOUNT',
          currency: 'USDT',
          paidAmount: 5_000,
          receiptExternalUrl: `${RECEIPT}6`,
        },
        ADMIN,
      ),
    ).rejects.toThrow(/Недостаточно средств/)
    expect((await rawRow(pending.id))!.status).toBe('PENDING')
  })

  it('a company-funded payout debits the balance by what was ACTUALLY paid', async () => {
    if (!dbAvailable) return
    await cleanup()
    await seedCompanyDeposit(1000)
    const before = await myContribution()

    const pending = await svc.createSalary(
      { receiverId: JUNIOR.id, amount: 100, currency: 'USD', salaryMonth: '2026-08' },
      ADMIN,
    )
    const paid = await svc.paySalary(
      pending.id,
      {
        fundingSource: 'COMPANY_ACCOUNT',
        currency: 'USDT',
        paidAmount: 900,
        receiptExternalUrl: `${RECEIPT}7`,
      },
      ADMIN,
    )

    expect(paid.status).toBe('PAID')
    expect(paid.currency).toBe('USDT')
    expect(parseFloat(paid.amount)).toBe(900)
    // −900 (what left the account), NOT −100 (what was nominally owed).
    expect(await myContribution()).toBeCloseTo(before - 900, 6)
    // And the obligation the 900 settled is still readable.
    expect(parseFloat(paid.originalAmount!)).toBe(100)
    expect(paid.originalCurrency).toBe('USD')
    expect(parseFloat(paid.exchangeRate!)).toBeCloseTo(9, 6)
  })
})
