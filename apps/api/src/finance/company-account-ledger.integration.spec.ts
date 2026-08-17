import { Global, Module } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { drizzle } from 'drizzle-orm/node-postgres'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'
// task-admin-income-unified: `createAdminIncome`'s old `fundingSource:
// 'COMPANY_ACCOUNT'` toggle is replaced by `receiverId` (see AC5 below).
import { COMPANY_ACCOUNT_RECEIVER } from '@crm/shared'

import { DatabaseService } from '../database/database.service'
import { TransactionsService } from './transactions.service'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'
import { CompanyAccountService } from './company-account.service'
import type { InvoicesService } from '../invoices/invoices.service'
import type { DocumentsService } from '../documents/documents.service'
import type { EtherscanService } from './etherscan.service'
import { computeCompanyAccountBalanceFromLedger } from './company-account-balance'
import { withIsolatedOffCurrencyRow } from './__test-helpers__/off-currency-fixture'
import { companyAccount, projects, transactions, users } from '../database/schema'
import * as schema from '../database/schema'

/**
 * task-salary-company-account — company-account LEDGER + RECONCILIATION (real DB).
 *
 * Asserts against REAL PostgreSQL (crm_qa scratch — NEVER crm_db):
 *   AC3 — paySalary stamps txDate = pay date; company-funded salary is gated by
 *         the company balance (BadRequest when short, debits when paid).
 *   AC4 — EXPENSE COMPANY_ACCOUNT: USDT, gated, debits the company balance;
 *         legacy EXPENSE (no fundingSource) does NOT touch the balance.
 *   AC5 — ADMIN_INCOME COMPANY_ACCOUNT: USDT, CREDITS the company balance AND is
 *         excluded from the admin owner's personal balance (getSummary);
 *         legacy ADMIN_INCOME credits the admin personal balance as before.
 *   AC6 — Reconciliation: the DISPLAY balance (CompanyAccountService.getAccount)
 *         == the GATE balance (computeCompanyAccountBalanceFromLedger) for a data
 *         set exercising ALL 6 ledger terms.
 *
 * No mocks for the balance math — both display and gate read the same ledger.
 * Invoices/Documents/Etherscan collaborators are stubbed (irrelevant here).
 *
 * Run against the scratch DB:
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_qa \
 *     pnpm --filter @crm/api test -- company-account-ledger.integration
 */

const ADMIN: SessionUser = {
  id: 'ca110000-0000-4000-aa00-000000000001',
  email: 'cal-admin@test.spec',
  displayName: 'CAL Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 26,
  legalFullName: null,
}
const SENIOR: SessionUser = {
  ...ADMIN,
  id: 'ca110000-0000-4000-aa00-000000000002',
  email: 'cal-senior@test.spec',
  displayName: 'CAL Senior',
  role: 'SENIOR',
}
const JUNIOR: SessionUser = {
  ...ADMIN,
  id: 'ca110000-0000-4000-aa00-000000000003',
  email: 'cal-junior@test.spec',
  displayName: 'CAL Junior',
  role: 'JUNIOR',
  seniorSharePercent: 0,
}

const ALL = [ADMIN, SENIOR, JUNIOR]
const TEST_USER_IDS = ALL.map((u) => u.id)
const ACCOUNT_ID = 'ca110000-0000-4000-cc00-000000000001'
const PROJECT_ID = 'ca110000-0000-4000-dd00-000000000001'
const WALLET = '0x2222222222222222222222222222222222222222'
const THRESHOLD = 12

const stubInvoices = {
  autoCreateForSalary: () => Promise.reject(new Error('stub')),
} as unknown as InvoicesService
const stubDocuments = {} as unknown as DocumentsService
const stubEtherscan = {} as unknown as EtherscanService

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
          invoicesService: stubInvoices,
          documentsService: stubDocuments,
          etherscanService: stubEtherscan,
        }),
      inject: [DatabaseService],
    },
    {
      provide: CompanyAccountService,
      useFactory: (db: DatabaseService) => new CompanyAccountService(db, stubEtherscan),
      inject: [DatabaseService],
    },
  ],
})
class LedgerTestModule {}

// task-receipts-backend (review round 1): createExpense/createAdminIncome/
// paySalary now require a mandatory receipt (USDT/COMPANY_ACCOUNT →
// explorer-only). This spec is about the ledger reconciliation, not the
// receipt gate itself (covered by finance.receipts.spec.ts) — a fixed valid
// explorer url keeps every call site deterministic.
const RECEIPT = { receiptExternalUrl: 'https://etherscan.io/tx/0xcompanyledgerspec' }

describe('company-account ledger + reconciliation (real DB, no mocks)', () => {
  let txSvc: TransactionsService
  let caSvc: CompanyAccountService
  let dbSvc: DatabaseService

  // Wipe every ledger row authored by our personas so the balance is fully
  // deterministic for each test.
  async function clearLedger() {
    const db = dbSvc.db
    await db.delete(transactions).where(inArray(transactions.createdBy, TEST_USER_IDS))
    await db.delete(transactions).where(inArray(transactions.senderId, TEST_USER_IDS))
    await db.delete(transactions).where(inArray(transactions.receiverId, TEST_USER_IDS))
  }

  // Seed a confirmed company deposit so the balance covers `amount`.
  async function seedDeposit(amount: number) {
    await dbSvc.db.insert(transactions).values({
      type: 'COMPANY_DEPOSIT',
      status: 'PAID',
      amount: String(amount),
      currency: 'USDT',
      senderId: SENIOR.id,
      createdBy: ADMIN.id,
    })
  }

  // DISPLAY balance via the public endpoint service (GLOBAL aggregate).
  async function displayBalance(): Promise<number> {
    return (await caSvc.getAccount(ADMIN)).balance
  }

  // GATE balance via the shared helper directly (same fn the service gates on,
  // GLOBAL aggregate). Used for the reconciliation (display == gate) check and
  // for sizing gate-trip amounts.
  async function gateBalance(): Promise<number> {
    return computeCompanyAccountBalanceFromLedger(dbSvc.db)
  }

  // PERSONA-SCOPED company-account contribution: the same 6-term formula but
  // restricted to rows authored by THIS spec's personas. Vitest runs spec FILES
  // in parallel and the company balance is a GLOBAL aggregate, so other files
  // mutating it concurrently would make global `before + delta` deltas racy.
  // Scoping the delta to our own rows makes every balance-delta assertion
  // deterministic regardless of what other specs do to the global balance.
  async function myContribution(): Promise<number> {
    const sumByType = async (type: string, companyFundedOnly: boolean): Promise<number> => {
      const conds = [
        eq(transactions.type, type as never),
        eq(transactions.status, 'PAID' as never),
        inArray(transactions.createdBy, TEST_USER_IDS),
        ...(companyFundedOnly ? [eq(transactions.fundingSource, 'COMPANY_ACCOUNT' as never)] : []),
      ]
      const rows = await dbSvc.db
        .select({ total: sql<string>`COALESCE(SUM(${transactions.amount}), 0)` })
        .from(transactions)
        .where(and(...conds))
      const total = parseFloat(rows[0]?.total ?? '0')
      return Number.isFinite(total) ? total : 0
    }
    const [deposits, payouts, adminIncome, dividends, salary, expense] = await Promise.all([
      sumByType('COMPANY_DEPOSIT', false),
      sumByType('PAYOUT', true),
      sumByType('ADMIN_INCOME', true),
      sumByType('DIVIDEND_TO_ADMIN', false),
      sumByType('SALARY', true),
      sumByType('EXPENSE', true),
    ])
    return deposits + payouts + adminIncome - dividends - salary - expense
  }

  beforeAll(async () => {
    try {
      const probe = new Pool({ connectionString: process.env['DATABASE_URL'] })
      await probe.query('SELECT 1')
      const check = await probe.query(
        `SELECT table_name FROM information_schema.tables WHERE table_name='company_account' LIMIT 1`,
      )
      const col = await probe.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name='transactions' AND column_name='funding_source' LIMIT 1`,
      )
      await probe.end()
      if (check.rowCount === 0 || col.rowCount === 0) {
        console.warn(
          '[company-account-ledger] SKIPPED — schema not present (company_account / funding_source)',
        )
        dbAvailable = false
        return
      }
    } catch {
      console.warn('[company-account-ledger] SKIPPED — no DB reachable at DATABASE_URL')
      dbAvailable = false
      return
    }

    const moduleRef = await Test.createTestingModule({ imports: [LedgerTestModule] }).compile()
    await moduleRef.init()
    txSvc = moduleRef.get(TransactionsService)
    caSvc = moduleRef.get(CompanyAccountService)
    dbSvc = moduleRef.get(DatabaseService)

    const db = dbSvc.db
    await clearLedger()
    await db.delete(projects).where(inArray(projects.id, [PROJECT_ID]))
    await db.delete(companyAccount).where(inArray(companyAccount.id, [ACCOUNT_ID]))
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

    // ADMIN-owned project so createAdminIncome (ADMIN caller) is authorized.
    await db
      .insert(projects)
      .values({
        id: PROJECT_ID,
        name: 'CAL Admin Project',
        companyName: 'CAL Client Ltd',
        domain: 'AI',
        rate: 50,
        startDate: new Date('2026-01-01T00:00:00Z'),
        seniorId: ADMIN.id,
      })
      .onConflictDoNothing()

    // Single company_account row at the test wallet.
    const existing = await db.query.companyAccount.findFirst()
    if (existing) {
      await db
        .update(companyAccount)
        .set({ walletAddress: WALLET, confirmationThreshold: THRESHOLD })
        .where(eq(companyAccount.id, existing.id))
    } else {
      await db.insert(companyAccount).values({
        id: ACCOUNT_ID,
        walletAddress: WALLET,
        confirmationThreshold: THRESHOLD,
        updatedBy: ADMIN.id,
      })
    }
  }, 30_000)

  beforeEach(async () => {
    if (!dbAvailable) return
    await clearLedger()
  })

  afterAll(async () => {
    if (!dbAvailable) return
    try {
      await clearLedger()
      await dbSvc.db.delete(projects).where(inArray(projects.id, [PROJECT_ID]))
      await dbSvc.db.delete(companyAccount).where(inArray(companyAccount.id, [ACCOUNT_ID]))
      await dbSvc.db.delete(users).where(inArray(users.id, TEST_USER_IDS))
    } catch {
      // non-fatal
    }
    await _pool?.end()
  }, 15_000)

  // NOTE on balance arithmetic: the company-account balance is a GLOBAL ledger
  // aggregate (it sums ALL company-funded rows in the DB, not just this spec's).
  // The scratch `crm_qa` carries pre-existing company rows, so every assertion is
  // DELTA-based against a freshly-read baseline; insufficient-balance cases ask
  // for `baseline + margin` so the gate is guaranteed to trip regardless of the
  // residual balance. We never assume an isolated balance of 0.

  // ── AC4 — EXPENSE COMPANY_ACCOUNT ──────────────────────────────────────────
  describe('EXPENSE — company account (AC4)', () => {
    it('USDT-forced, gated, debits the company balance', async () => {
      if (!dbAvailable) return
      await seedDeposit(1000) // ensure the gate passes regardless of baseline
      const before = await myContribution()
      const tx = await txSvc.createExpense(
        {
          amount: 300,
          currency: 'UAH',
          category: 'Office',
          fundingSource: 'COMPANY_ACCOUNT',
          ...RECEIPT,
        },
        ADMIN,
      )
      expect(tx.currency).toBe('USDT')
      const row = await dbSvc.db.query.transactions.findFirst({ where: eq(transactions.id, tx.id) })
      expect((row as { fundingSource?: string | null }).fundingSource).toBe('COMPANY_ACCOUNT')
      // Our scoped contribution dropped by exactly 300 (deposit +1000 was before).
      expect(await myContribution()).toBe(before - 300)
    })

    it('insufficient balance → BadRequest', async () => {
      if (!dbAvailable) return
      // Ask for far more than the GLOBAL balance so the gate trips even if a
      // concurrent spec deposits funds between our read and the gate check.
      const tooMuch = (await gateBalance()) + 1_000_000
      await expect(
        txSvc.createExpense(
          {
            amount: tooMuch,
            currency: 'USDT',
            category: 'X',
            fundingSource: 'COMPANY_ACCOUNT',
            ...RECEIPT,
          },
          ADMIN,
        ),
      ).rejects.toThrowError(/Недостаточно средств/)
    })

    it('legacy EXPENSE (no fundingSource) does NOT touch the company balance', async () => {
      if (!dbAvailable) return
      const before = await myContribution()
      const tx = await txSvc.createExpense(
        { amount: 500, currency: 'USD', category: 'Legacy', ...RECEIPT },
        ADMIN,
      )
      const row = await dbSvc.db.query.transactions.findFirst({ where: eq(transactions.id, tx.id) })
      expect((row as { fundingSource?: string | null }).fundingSource ?? null).toBeNull()
      expect(tx.currency).toBe('USD')
      expect(await myContribution()).toBe(before)
    })

    // SEC-1 (mega-audit wave 2, round 4, MED) — BEHAVIOURAL proof that
    // createExpense is one of the four gates the off-currency guard protects.
    // `TransactionsService.computeCompanyAccountBalance` (transactions
    // .service.ts:3587, out of this task's zone) is a private one-line
    // delegate to `computeCompanyAccountBalanceFromLedger`; a future edit
    // that swapped it for `computeCompanyAccountBalanceForDisplay` (looking
    // like a harmless "unify the two readers" refactor) would make this
    // gate silently accept a debit against an unreliable balance — no
    // *structural* test (asserting on which function is imported/called)
    // exists for that file per this task's zone, so this is the actual
    // money-movement behaviour, exercised through the real service.
    //
    // ACCEPTED RISK (round 4, isolation): this test does NOT use
    // `withIsolatedOffCurrencyRow` (the session-advisory-lock fixture used
    // elsewhere in this file/company-account-balance-off-currency
    // .integration.spec.ts). `createExpense` ITSELF acquires the shared
    // `COMPANY_ACCOUNT_LOCK_KEY` advisory lock before reading the balance —
    // holding that SAME lock around this call would deadlock the call
    // against itself (proven empirically while writing this test: the
    // process hung with two backends both blocked on
    // `pg_advisory_xact_lock`, killed and confirmed via `pg_stat_activity`).
    // The row is therefore visible, briefly, WITHOUT lock protection: insert
    // → one gate call → delete, no artificial delay, minimising the window.
    // A concurrent createExpense/paySalary/settleByCompany/createDividend in
    // another agent's process during that narrow window would also
    // (correctly, if confusingly) reject — the SAME residual risk every
    // C-3 test in company-account-balance-off-currency.integration.spec.ts
    // carried before round 4 added locking for the READ-ONLY cases.
    it('SEC-1: an off-currency company row BLOCKS createExpense — no EXPENSE row is created, no debit happens', async () => {
      if (!dbAvailable) return
      await seedDeposit(1000) // would otherwise easily cover the expense below

      const fixtureId = 'ca110000-0000-4000-ee00-000000000001'
      await dbSvc.db.insert(transactions).values({
        id: fixtureId,
        type: 'EXPENSE',
        status: 'PAID',
        amount: '250',
        currency: 'UAH',
        senderId: ADMIN.id,
        fundingSource: 'COMPANY_ACCOUNT',
        createdBy: ADMIN.id,
      })
      try {
        // Baseline captured AFTER the fixture row is committed (the fixture
        // itself is EXPENSE/COMPANY_ACCOUNT/createdBy=ADMIN — it inherently
        // moves `myContribution()`'s own unscoped-by-currency EXPENSE term;
        // we isolate createExpense's OWN effect against THIS baseline, not
        // against a pre-fixture one).
        const before = await myContribution()

        await expect(
          txSvc.createExpense(
            {
              amount: 300,
              currency: 'USDT',
              category: 'Blocked by off-currency guard',
              fundingSource: 'COMPANY_ACCOUNT',
              ...RECEIPT,
            },
            ADMIN,
          ),
        ).rejects.toThrow()

        // The debit never happened — no additional movement beyond the
        // fixture's own already-baselined contribution.
        expect(await myContribution()).toBe(before)
      } finally {
        await dbSvc.db.delete(transactions).where(eq(transactions.id, fixtureId))
      }
    })
  })

  // ── AC5 — ADMIN_INCOME COMPANY_ACCOUNT ─────────────────────────────────────
  describe('ADMIN_INCOME — company account (AC5)', () => {
    it('USDT-forced, CREDITS company balance, EXCLUDED from admin personal balance', async () => {
      if (!dbAvailable) return
      const companyBefore = await myContribution()
      const summaryBefore = await txSvc.getSummary(ADMIN)
      const adminBalBefore =
        summaryBefore.adminBalances.find((b) => b.userId === ADMIN.id)?.balance ?? 0

      const tx = await txSvc.createAdminIncome(
        {
          projectId: PROJECT_ID,
          amount: 700,
          currency: 'UAH',
          receiverId: COMPANY_ACCOUNT_RECEIVER,
          ...RECEIPT,
        },
        ADMIN,
      )
      expect(tx.currency).toBe('USDT')
      const row = await dbSvc.db.query.transactions.findFirst({ where: eq(transactions.id, tx.id) })
      expect((row as { fundingSource?: string | null }).fundingSource).toBe('COMPANY_ACCOUNT')

      // Company-account contribution credited by exactly the amount.
      expect(await myContribution()).toBe(companyBefore + 700)

      // Admin PERSONAL balance is UNCHANGED (income went to the pool). The
      // getSummary admin balance only counts rows with receiverId=ADMIN.id,
      // which are our persona's rows — already isolated from other specs.
      const summaryAfter = await txSvc.getSummary(ADMIN)
      const adminBalAfter =
        summaryAfter.adminBalances.find((b) => b.userId === ADMIN.id)?.balance ?? 0
      expect(adminBalAfter).toBe(adminBalBefore)
    })

    it('legacy ADMIN_INCOME credits the admin personal balance (company balance untouched)', async () => {
      if (!dbAvailable) return
      const companyBefore = await myContribution()
      const summaryBefore = await txSvc.getSummary(ADMIN)
      const adminBalBefore =
        summaryBefore.adminBalances.find((b) => b.userId === ADMIN.id)?.balance ?? 0

      await txSvc.createAdminIncome(
        { projectId: PROJECT_ID, amount: 250, currency: 'USDT', ...RECEIPT },
        ADMIN,
      )

      expect(await myContribution()).toBe(companyBefore) // pool unaffected
      const summaryAfter = await txSvc.getSummary(ADMIN)
      const adminBalAfter =
        summaryAfter.adminBalances.find((b) => b.userId === ADMIN.id)?.balance ?? 0
      expect(adminBalAfter).toBe(adminBalBefore + 250) // personal credited
    })
  })

  // ── AC3 — paySalary: txDate + gate ─────────────────────────────────────────
  describe('paySalary — pay date + company gate (AC3)', () => {
    // Insert a PENDING company-funded salary the way the cron would.
    async function seedPendingCompanySalary(amount: number): Promise<string> {
      const [row] = await dbSvc.db
        .insert(transactions)
        .values({
          type: 'SALARY',
          status: 'PENDING',
          amount: String(amount),
          currency: 'USDT',
          senderId: null,
          senderLabel: 'Счёт компании',
          receiverId: JUNIOR.id,
          salaryMonth: '2026-06',
          fundingSource: 'COMPANY_ACCOUNT',
          // Created "yesterday" so we can prove txDate becomes the PAY date.
          txDate: new Date('2026-05-01T00:00:00Z'),
          createdBy: ADMIN.id,
        })
        .returning()
      return row!.id
    }

    it('blocks when company balance is short', async () => {
      if (!dbAvailable) return
      // Pending salary far larger than the GLOBAL balance so the pay gate trips
      // even under concurrent deposits from other specs.
      const tooMuch = (await gateBalance()) + 1_000_000
      const id = await seedPendingCompanySalary(tooMuch)
      await expect(
        txSvc.paySalary(
          id,
          { fundingSource: 'COMPANY_ACCOUNT', currency: 'USDT', ...RECEIPT },
          ADMIN,
        ),
      ).rejects.toThrowError(/Недостаточно средств/)
    })

    it('pays when funded: stamps txDate = pay date and debits the balance', async () => {
      if (!dbAvailable) return
      await seedDeposit(1000)
      // A PENDING salary is not yet counted by the balance formula, so our scoped
      // contribution at this point reflects only the +1000 deposit.
      const before = await myContribution()
      const startedAt = Date.now() - 1000
      const id = await seedPendingCompanySalary(400)

      const paid = await txSvc.paySalary(
        id,
        { fundingSource: 'COMPANY_ACCOUNT', currency: 'USDT', ...RECEIPT },
        ADMIN,
      )
      expect(paid.status).toBe('PAID')

      const row = await dbSvc.db.query.transactions.findFirst({ where: eq(transactions.id, id) })
      const txDate = (row as { txDate: Date | null }).txDate
      expect(txDate).not.toBeNull()
      // txDate is now (pay date), NOT the seeded 2026-05-01 creation date.
      expect(txDate!.getTime()).toBeGreaterThanOrEqual(startedAt)

      // Contribution debited by the salary amount once it flipped to PAID.
      expect(await myContribution()).toBe(before - 400)
    })

    // SEC-1 (mega-audit wave 2, round 4, MED) — BEHAVIOURAL proof that
    // paySalary is one of the four gates the off-currency guard protects.
    // Same private one-line delegate as createExpense
    // (transactions.service.ts:3587, out of this task's zone) — a future
    // "unify the two readers" edit there would make this gate silently pay
    // a salary against an unreliable balance without any test in THIS
    // zone noticing. Proven through the real service: the PENDING salary
    // must stay PENDING, not flip to PAID.
    //
    // ACCEPTED RISK (round 4, isolation): same reasoning as the createExpense
    // test above — `paySalary` itself acquires `COMPANY_ACCOUNT_LOCK_KEY`,
    // so `withIsolatedOffCurrencyRow` would deadlock this call against its
    // own isolation lock. Plain insert → one gate call → delete, no
    // artificial delay, minimal window; see the createExpense test's comment
    // for the full rationale and the empirical proof of the deadlock.
    it('SEC-1: an off-currency company row BLOCKS paySalary — the salary stays PENDING, no money moves', async () => {
      if (!dbAvailable) return
      await seedDeposit(1000) // would otherwise easily cover the salary below
      const id = await seedPendingCompanySalary(400)

      const fixtureId = 'ca110000-0000-4000-ee00-000000000002'
      await dbSvc.db.insert(transactions).values({
        id: fixtureId,
        type: 'EXPENSE',
        status: 'PAID',
        amount: '250',
        currency: 'UAH',
        senderId: ADMIN.id,
        fundingSource: 'COMPANY_ACCOUNT',
        createdBy: ADMIN.id,
      })
      try {
        await expect(
          txSvc.paySalary(
            id,
            { fundingSource: 'COMPANY_ACCOUNT', currency: 'USDT', ...RECEIPT },
            ADMIN,
          ),
        ).rejects.toThrow()

        const row = await dbSvc.db.query.transactions.findFirst({
          where: eq(transactions.id, id),
        })
        expect((row as { status: string }).status).toBe('PENDING')
      } finally {
        await dbSvc.db.delete(transactions).where(eq(transactions.id, fixtureId))
      }
    })
  })

  // ── AC6 — Reconciliation: display == gate across ALL six terms ─────────────
  describe('reconciliation — display balance == gate balance (AC6)', () => {
    it('display (getAccount) and gate (shared helper) agree with all 6 terms present', async () => {
      if (!dbAvailable) return

      // Our own scoped contribution before inserting the six rows.
      const baseline = await myContribution()

      // Build a ledger that exercises EVERY term:
      //   +deposit 1000, +payout(COMPANY) 200, +adminIncome(COMPANY) 300,
      //   −dividend 150, −salary(COMPANY) 250, −expense(COMPANY) 120
      //   → net delta = 1000 + 200 + 300 − 150 − 250 − 120 = 980
      await dbSvc.db.insert(transactions).values([
        {
          type: 'COMPANY_DEPOSIT',
          status: 'PAID',
          amount: '1000',
          currency: 'USDT',
          senderId: SENIOR.id,
          createdBy: ADMIN.id,
        },
        {
          type: 'PAYOUT',
          status: 'PAID',
          amount: '200',
          currency: 'USDT',
          senderId: SENIOR.id,
          fundingSource: 'COMPANY_ACCOUNT',
          createdBy: ADMIN.id,
        },
        {
          type: 'ADMIN_INCOME',
          status: 'PAID',
          amount: '300',
          currency: 'USDT',
          receiverId: ADMIN.id,
          fundingSource: 'COMPANY_ACCOUNT',
          createdBy: ADMIN.id,
        },
        {
          type: 'DIVIDEND_TO_ADMIN',
          status: 'PAID',
          amount: '150',
          currency: 'USDT',
          receiverId: ADMIN.id,
          createdBy: ADMIN.id,
        },
        {
          type: 'SALARY',
          status: 'PAID',
          amount: '250',
          currency: 'USDT',
          receiverId: JUNIOR.id,
          salaryMonth: '2026-06',
          fundingSource: 'COMPANY_ACCOUNT',
          createdBy: ADMIN.id,
        },
        {
          type: 'EXPENSE',
          status: 'PAID',
          amount: '120',
          currency: 'USDT',
          senderId: null,
          fundingSource: 'COMPANY_ACCOUNT',
          createdBy: ADMIN.id,
        },
      ])

      // RECONCILIATION (the core AC6 claim): the DISPLAY balance and the GATE
      // balance are produced by the SAME shared function, so for identical global
      // state they are byte-for-byte identical. Read gate, display, gate again;
      // display must sit exactly on a gate reading (sandwich tolerates a
      // concurrent insert from a parallel spec without false-failing).
      const g1 = await gateBalance()
      const display = await displayBalance()
      const g2 = await gateBalance()
      expect([g1, g2]).toContain(display)

      // Our scoped contribution moved by EXACTLY +980 (deterministic correctness
      // of all six terms, independent of any concurrent global activity).
      expect(await myContribution()).toBe(baseline + 980)
    })

    it('non-COMPANY_ACCOUNT salary/expense/admin-income do NOT affect the balance', async () => {
      if (!dbAvailable) return
      const baseline = await myContribution()
      await dbSvc.db.insert(transactions).values([
        {
          type: 'COMPANY_DEPOSIT',
          status: 'PAID',
          amount: '500',
          currency: 'USDT',
          senderId: SENIOR.id,
          createdBy: ADMIN.id,
        },
        // ADMIN_PERSONAL salary — must NOT debit the company balance.
        {
          type: 'SALARY',
          status: 'PAID',
          amount: '999',
          currency: 'USDT',
          receiverId: JUNIOR.id,
          salaryMonth: '2026-06',
          fundingSource: 'ADMIN_PERSONAL',
          createdBy: ADMIN.id,
        },
        // Legacy expense (NULL funding) — must NOT debit.
        {
          type: 'EXPENSE',
          status: 'PAID',
          amount: '888',
          currency: 'USD',
          senderId: ADMIN.id,
          createdBy: ADMIN.id,
        },
        // Legacy admin income (NULL funding) — must NOT credit.
        {
          type: 'ADMIN_INCOME',
          status: 'PAID',
          amount: '777',
          currency: 'USD',
          receiverId: ADMIN.id,
          createdBy: ADMIN.id,
        },
      ])
      // Only the +500 deposit moved OUR scoped contribution; the ADMIN_PERSONAL
      // salary, legacy expense and legacy admin-income are all ignored by the
      // formula (deterministic regardless of concurrent global activity).
      expect(await myContribution()).toBe(baseline + 500)
    })
  })

  // ── SEC-1 (mega-audit wave 2, round 3) — display path survives an ────────
  //    off-currency row, THROUGH THE REAL SERVICE against REAL Postgres ────
  describe('SEC-1: getAccount() degrades instead of 500ing on a real off-currency row (round 3)', () => {
    it('a genuine off-currency company row does NOT throw through caSvc.getAccount() — the screen stays alive', async () => {
      if (!dbAvailable) return
      await seedDeposit(1000) // ensure a non-trivial ledger baseline

      // A company-funded EXPENSE booked in UAH — the write path is SUPPOSED to
      // hardcode USDT (createExpense); this row simulates the ONE future-bug
      // scenario C-3/SEC-1 are about (a write path that forgets to).
      //
      // crm_qa is a shared scratch DB; the off-currency guard scans the WHOLE
      // table, so this row is briefly visible to any OTHER concurrently
      // running gate call too. Cleaned up explicitly in `finally` (on top of
      // the next `beforeEach`'s clearLedger()) to keep that window minimal.
      await dbSvc.db.insert(transactions).values({
        type: 'EXPENSE',
        status: 'PAID',
        amount: '250',
        currency: 'UAH',
        senderId: ADMIN.id,
        fundingSource: 'COMPANY_ACCOUNT',
        createdBy: ADMIN.id,
      })

      try {
        // The GATE (shared helper, same one createExpense/paySalary/
        // settleByCompany/createDividend call directly) still throws —
        // unchanged by round 3.
        await expect(gateBalance()).rejects.toThrow()

        // getAccount() — the REAL service method behind GET /api/company-account
        // — does NOT throw. It resolves with a finite, plain-number balance
        // (CompanyAccountDto.balance stays z.number(); no shape change).
        const acc = await caSvc.getAccount(ADMIN)
        expect(typeof acc.balance).toBe('number')
        expect(Number.isFinite(acc.balance)).toBe(true)
        expect(acc.walletAddress).toBeDefined()
      } finally {
        await clearLedger()
      }
    })
  })
})
