import { Global, Module } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { drizzle } from 'drizzle-orm/node-postgres'
import { inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'

import { DatabaseService } from '../database/database.service'
import { TransactionsService } from './transactions.service'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'
import type { InvoicesService } from '../invoices/invoices.service'
import type { EtherscanService } from './etherscan.service'
import type { NbuCurrencyService } from './nbu-currency.service'
import { companyAccount, transactions, users } from '../database/schema'
import * as schema from '../database/schema'
import { computeCompanyAccountBalanceFromLedger } from './company-account-balance'

/**
 * task-review-followup #2b — invoice auto-create on BOTH paySalary funding paths.
 *
 * `paySalary` calls `safeAutoCreateInvoice('SALARY', id)` after flipping PAID.
 * This spec proves the call fires regardless of whether the salary is paid from
 * COMPANY_ACCOUNT or ADMIN_PERSONAL — covering the code-review finding that the
 * invoice trigger must be present on BOTH branches.
 *
 * Strategy: spy on `invoicesService.autoCreateForSalary` (the method that
 * `safeAutoCreateInvoice('SALARY', ...)` dispatches to). The spy resolves
 * immediately — no PDF gen, no S3, no real InvoicesService internals — but the
 * call count / args are asserted. This gives us a REAL-DB path (createSalary →
 * paySalary with balance gate + tx flip) without the S3/PDF overhead.
 *
 * Run against a scratch DB (NEVER the live crm_db):
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_qa \
 *     pnpm --filter @crm/api test -- pay-salary-invoice.integration
 */

const ADMIN: SessionUser = {
  id: 'bb330000-0000-4000-aa00-000000000001',
  email: 'si-admin@test.spec',
  displayName: 'SI Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 0,
  legalFullName: null,
}
const ADMIN2: SessionUser = {
  ...ADMIN,
  id: 'bb330000-0000-4000-aa00-000000000002',
  email: 'si-admin2@test.spec',
  displayName: 'SI Admin Two',
}
const JUNIOR: SessionUser = {
  ...ADMIN,
  id: 'bb330000-0000-4000-aa00-000000000003',
  email: 'si-junior@test.spec',
  displayName: 'SI Junior',
  role: 'JUNIOR',
}

const ALL = [ADMIN, ADMIN2, JUNIOR]
const TEST_USER_IDS = ALL.map((u) => u.id)
const DEPOSIT_ID = 'bb330000-0000-4000-cc00-000000000001'

// ── Stub collaborators ────────────────────────────────────────────────────────
// The invoicesService stub is a plain object whose `autoCreateForSalary` is a
// vi.fn() so we can spy on calls. Other methods are no-ops (never reached on
// the paySalary → safeAutoCreateInvoice('SALARY') path).
const invoiceAutoCreateSpy = vi.fn().mockResolvedValue(undefined)
const stubInvoices = {
  autoCreateForPayout: vi.fn().mockResolvedValue(undefined),
  autoCreateForSeniorPayout: vi.fn().mockResolvedValue(undefined),
  autoCreateForSalary: invoiceAutoCreateSpy,
} as unknown as InvoicesService

const stubDocuments = {} as never

const fakeNbu: Pick<NbuCurrencyService, 'getRates'> = {
  getRates: () =>
    Promise.resolve({
      usdUah: '40.0000',
      usdtUah: '40.0000',
      eurUah: '44.0000',
      date: '20260620',
    }),
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
} as never

// ── TestDatabaseModule (real Pool) ──────────────────────────────────────────
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
          invoicesService: stubInvoices as unknown as InvoicesService,
          nbuCurrencyService: fakeNbu as NbuCurrencyService,
          etherscanService: fakeEtherscan as EtherscanService,
        }),
      inject: [DatabaseService],
    },
  ],
})
class PaySalaryInvoiceTestModule {}

describe('paySalary invoice auto-create — both funding paths (real DB, spy on invoicesService)', () => {
  let svc: TransactionsService
  let dbSvc: DatabaseService

  async function cleanup() {
    await dbSvc.db.delete(transactions).where(inArray(transactions.createdBy, TEST_USER_IDS))
    await dbSvc.db.delete(transactions).where(inArray(transactions.id, [DEPOSIT_ID]))
  }

  beforeAll(async () => {
    try {
      const probe = new Pool({ connectionString: process.env['DATABASE_URL'] })
      await probe.query('SELECT 1')
      const check = await probe.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name='transactions' AND column_name='funding_source' LIMIT 1`,
      )
      await probe.end()
      if (check.rowCount === 0) {
        console.warn('[pay-salary-invoice] SKIPPED — funding_source column not found')
        dbAvailable = false
        return
      }
    } catch {
      console.warn('[pay-salary-invoice] SKIPPED — no DB reachable at DATABASE_URL')
      dbAvailable = false
      return
    }

    const moduleRef = await Test.createTestingModule({
      imports: [PaySalaryInvoiceTestModule],
    }).compile()
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

  // Reset spy call counts between tests so assertions are per-case.
  // We cannot use beforeEach because the DB setup runs once in beforeAll.
  function resetSpies() {
    invoiceAutoCreateSpy.mockClear()
  }

  // Helper: seed a company deposit so the balance covers `amount`.
  async function seedCompanyDeposit(amount: number) {
    const existing = await dbSvc.db.query.companyAccount.findFirst()
    if (!existing) {
      // Ensure company account row exists for balance ledger.
      await dbSvc.db.insert(companyAccount).values({
        id: DEPOSIT_ID,
        walletAddress: '0x000000000000000000000000000000000000dead',
        confirmationThreshold: 12,
        updatedBy: ADMIN.id,
      })
    }
    await dbSvc.db.insert(transactions).values({
      id: DEPOSIT_ID,
      type: 'COMPANY_DEPOSIT',
      status: 'PAID',
      amount: String(amount),
      currency: 'USDT',
      senderId: ADMIN.id,
      createdBy: ADMIN.id,
    })
  }

  async function liveBalance(): Promise<number> {
    return computeCompanyAccountBalanceFromLedger(dbSvc.db)
  }

  // ── AC: COMPANY_ACCOUNT path triggers invoice auto-create ──────────────────
  it('paySalary COMPANY_ACCOUNT → autoCreateForSalary called once with the tx id', async () => {
    if (!dbAvailable) return
    resetSpies()
    await cleanup()

    // Need sufficient balance for the company-account gate.
    const balance = await liveBalance()
    const salaryAmount = 100
    if (balance < salaryAmount) {
      await seedCompanyDeposit(salaryAmount * 2)
    }

    const pending = await svc.createSalary(
      { receiverId: JUNIOR.id, amount: salaryAmount, currency: 'USDT', salaryMonth: '2026-06' },
      ADMIN,
    )

    // task-receipts-backend (review round 1): pay-time proof now MANDATORY
    // (COMPANY_ACCOUNT → USDT → explorer-only).
    const paid = await svc.paySalary(
      pending.id,
      {
        fundingSource: 'COMPANY_ACCOUNT',
        currency: 'USDT',
        receiptExternalUrl: 'https://etherscan.io/tx/0xpaysalaryinvoicespec',
      },
      ADMIN,
    )

    expect(paid.status).toBe('PAID')
    // safeAutoCreateInvoice('SALARY', id) must have forwarded to autoCreateForSalary.
    expect(invoiceAutoCreateSpy).toHaveBeenCalledTimes(1)
    expect(invoiceAutoCreateSpy).toHaveBeenCalledWith(paid.id)
  })

  // ── AC: ADMIN_PERSONAL path also triggers invoice auto-create ──────────────
  it('paySalary ADMIN_PERSONAL → autoCreateForSalary called once with the tx id', async () => {
    if (!dbAvailable) return
    resetSpies()
    await cleanup()

    const pending = await svc.createSalary(
      { receiverId: JUNIOR.id, amount: 150, currency: 'USD', salaryMonth: '2026-06' },
      ADMIN,
    )

    // ADMIN_PERSONAL: payer = ADMIN2 (a valid ADMIN user in the DB).
    // task-receipts-backend (review round 1): pay-time proof now MANDATORY.
    const paid = await svc.paySalary(
      pending.id,
      {
        fundingSource: 'ADMIN_PERSONAL',
        payerAdminId: ADMIN2.id,
        currency: 'USD',
        receiptExternalUrl: 'https://drive.google.com/file/paysalaryinvoicespec',
      },
      ADMIN,
    )

    expect(paid.status).toBe('PAID')
    // The invoice trigger must fire on the ADMIN_PERSONAL path too — this is
    // the coverage gap identified in the code-review (#254 code MED).
    expect(invoiceAutoCreateSpy).toHaveBeenCalledTimes(1)
    expect(invoiceAutoCreateSpy).toHaveBeenCalledWith(paid.id)
  })

  // ── Sanity: safeAutoCreateInvoice is fire-and-forget (errors are swallowed) ──
  it('paySalary succeeds even when autoCreateForSalary throws (fire-and-forget)', async () => {
    if (!dbAvailable) return
    resetSpies()
    await cleanup()

    // Override to simulate an invoice-creation failure.
    invoiceAutoCreateSpy.mockRejectedValueOnce(new Error('S3 outage'))

    const pending = await svc.createSalary(
      { receiverId: JUNIOR.id, amount: 200, currency: 'USD', salaryMonth: '2026-06' },
      ADMIN,
    )
    // task-receipts-backend (review round 1): pay-time proof now MANDATORY.
    const paid = await svc.paySalary(
      pending.id,
      {
        fundingSource: 'ADMIN_PERSONAL',
        payerAdminId: ADMIN2.id,
        currency: 'USD',
        receiptExternalUrl: 'https://drive.google.com/file/paysalaryinvoicespec2',
      },
      ADMIN,
    )
    // paySalary must succeed despite the invoice error (safeAutoCreateInvoice swallows).
    expect(paid.status).toBe('PAID')
    // Restore the default (resolve) for subsequent tests.
    invoiceAutoCreateSpy.mockResolvedValue(undefined)
  })
})
