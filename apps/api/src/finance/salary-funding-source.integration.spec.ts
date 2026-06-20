import { Global, Module } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { drizzle } from 'drizzle-orm/node-postgres'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'

import { DatabaseService } from '../database/database.service'
import { TransactionsService } from './transactions.service'
import { InvoicesService } from '../invoices/invoices.service'
import { DocumentsService } from '../documents/documents.service'
import { computeCompanyAccountBalanceFromLedger } from './company-account-balance'
import { transactions, users } from '../database/schema'
import * as schema from '../database/schema'

/**
 * task-company-account-backend — AC7: createSalary funding source (real DB).
 *
 * Asserts, against REAL PostgreSQL:
 *   - COMPANY_ACCOUNT → currency forced to USDT, funding_source persisted,
 *     senderId null; balance gate throws when the company account is short.
 *   - With sufficient company balance the salary is created and DEBITS the
 *     company balance (company-funded SALARY counts against it).
 *   - ADMIN_PERSONAL with a non-ADMIN payerAdminId → BadRequest.
 *   - ADMIN_PERSONAL with an ADMIN payer → funding_source set, sender = payer.
 *   - task-salary-company-account DEFAULT FLIP: an ABSENT fundingSource now
 *     resolves to COMPANY_ACCOUNT (USDT, sender null, gated) — NOT the old
 *     ADMIN_PERSONAL/NULL legacy behaviour.
 *   - #222 invariant preserved: ADMIN receiver still rejected regardless of
 *     funding source.
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
        new TransactionsService(
          db,
          {} as unknown as InvoicesService,
          {} as unknown as DocumentsService,
        ),
      inject: [DatabaseService],
    },
  ],
})
class FundingSourceTestModule {}

describe('createSalary — funding source (real DB, no mocks) — AC7', () => {
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
        console.warn('[salary-funding-source] SKIPPED — funding_source column not found')
        dbAvailable = false
        return
      }
    } catch {
      console.warn('[salary-funding-source] SKIPPED — no DB reachable at DATABASE_URL')
      dbAvailable = false
      return
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
    if (!dbAvailable) return
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

  it('COMPANY_ACCOUNT with insufficient balance → BadRequest', async () => {
    if (!dbAvailable) return
    await cleanup()
    // Ask for FAR more than the live balance so the gate trips deterministically,
    // even if a concurrent spec deposits funds between our read and the gate.
    const tooMuch = (await liveBalance()) + 1_000_000
    await expect(
      svc.createSalary(
        {
          receiverId: JUNIOR.id,
          amount: tooMuch,
          salaryMonth: '2026-06',
          fundingSource: 'COMPANY_ACCOUNT',
        },
        ADMIN,
      ),
    ).rejects.toThrowError(/Недостаточно средств/)
  })

  it('COMPANY_ACCOUNT with sufficient balance → USDT forced + funding_source set + sender null', async () => {
    if (!dbAvailable) return
    await cleanup()
    await seedCompanyDeposit(1000)
    // currency 'UAH' supplied but must be forced to USDT for a company-funded row.
    const tx = await svc.createSalary(
      {
        receiverId: JUNIOR.id,
        amount: 400,
        currency: 'UAH',
        salaryMonth: '2026-06',
        fundingSource: 'COMPANY_ACCOUNT',
      },
      ADMIN,
    )
    expect(tx.currency).toBe('USDT')
    expect(tx.senderId).toBeNull()

    const row = await dbSvc.db.query.transactions.findFirst({ where: eq(transactions.id, tx.id) })
    expect((row as { fundingSource?: string | null }).fundingSource).toBe('COMPANY_ACCOUNT')
  })

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

  it('company-funded SALARY DEBITS the company balance (PAID salary counts)', async () => {
    if (!dbAvailable) return
    await cleanup()
    await seedCompanyDeposit(1000)
    const before = await myContribution() // +1000 (deposit), 0 salary
    await svc.createSalary(
      {
        receiverId: JUNIOR.id,
        amount: 600,
        salaryMonth: '2026-06',
        fundingSource: 'COMPANY_ACCOUNT',
      },
      ADMIN,
    )
    // The PAID company salary is counted by the balance formula → contribution
    // drops by exactly the salary amount.
    expect(await myContribution()).toBe(before - 600)
  })

  it('ADMIN_PERSONAL with a NON-ADMIN payerAdminId → BadRequest', async () => {
    if (!dbAvailable) return
    await expect(
      svc.createSalary(
        {
          receiverId: SENIOR.id,
          amount: 100,
          salaryMonth: '2026-06',
          fundingSource: 'ADMIN_PERSONAL',
          payerAdminId: JUNIOR.id,
        },
        ADMIN,
      ),
    ).rejects.toThrowError(/ADMIN/)
  })

  it('ADMIN_PERSONAL with an ADMIN payer → funding_source set, sender = payer', async () => {
    if (!dbAvailable) return
    const tx = await svc.createSalary(
      {
        receiverId: SENIOR.id,
        amount: 100,
        currency: 'UAH',
        salaryMonth: '2026-06',
        fundingSource: 'ADMIN_PERSONAL',
        payerAdminId: ADMIN2.id,
      },
      ADMIN,
    )
    expect(tx.senderId).toBe(ADMIN2.id)
    // ADMIN_PERSONAL preserves the supplied currency (USDT|UAH allowed).
    expect(tx.currency).toBe('UAH')
    const row = await dbSvc.db.query.transactions.findFirst({ where: eq(transactions.id, tx.id) })
    expect((row as { fundingSource?: string | null }).fundingSource).toBe('ADMIN_PERSONAL')
  })

  // task-salary-company-account DEFAULT FLIP: an ABSENT fundingSource now
  // resolves to COMPANY_ACCOUNT (was ADMIN_PERSONAL/legacy caller-as-payer).
  // The salary is therefore USDT, sender null, funding_source=COMPANY_ACCOUNT,
  // and is gated by the company balance — so a deposit must be seeded first.
  it('absent fundingSource → COMPANY_ACCOUNT default (USDT, sender null, gated)', async () => {
    if (!dbAvailable) return
    await cleanup()
    await seedCompanyDeposit(1000)
    const tx = await svc.createSalary(
      { receiverId: JUNIOR.id, amount: 50, salaryMonth: '2026-06' },
      ADMIN,
    )
    expect(tx.senderId).toBeNull()
    expect(tx.currency).toBe('USDT')
    const row = await dbSvc.db.query.transactions.findFirst({ where: eq(transactions.id, tx.id) })
    expect((row as { fundingSource?: string | null }).fundingSource).toBe('COMPANY_ACCOUNT')
  })

  it('absent fundingSource over the live balance → BadRequest (default is gated)', async () => {
    if (!dbAvailable) return
    await cleanup()
    // Default (absent) funding is COMPANY_ACCOUNT and gated — ask for more than
    // the live balance so it trips regardless of the residual crm_qa balance.
    const tooMuch = (await liveBalance()) + 1_000_000
    await expect(
      svc.createSalary({ receiverId: JUNIOR.id, amount: tooMuch, salaryMonth: '2026-06' }, ADMIN),
    ).rejects.toThrowError(/Недостаточно средств/)
  })

  it('#222 invariant preserved: ADMIN receiver rejected even with COMPANY_ACCOUNT', async () => {
    if (!dbAvailable) return
    await cleanup()
    await seedCompanyDeposit(1000)
    await expect(
      svc.createSalary(
        {
          receiverId: ADMIN2.id,
          amount: 100,
          salaryMonth: '2026-06',
          fundingSource: 'COMPANY_ACCOUNT',
        },
        ADMIN,
      ),
    ).rejects.toThrowError(/ADMIN не получает зарплату/)
  })

  it('sanity: company-funded rows are queryable by funding_source filter', async () => {
    if (!dbAvailable) return
    const rows = await dbSvc.db
      .select({ id: transactions.id })
      .from(transactions)
      .where(
        and(eq(transactions.type, 'SALARY'), eq(transactions.fundingSource, 'COMPANY_ACCOUNT')),
      )
    expect(Array.isArray(rows)).toBe(true)
  })
})
