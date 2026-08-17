/**
 * task-finance-fix-wave1 / E-1 — real-DB behaviour of the archived-receiver
 * barrier. The unit spec (salary-archived-receiver.unit.spec.ts) pins the
 * predicate and the two throws; this one proves the OUTCOME against actual
 * PostgreSQL, where the `where` clause is executed rather than inspected:
 *
 *   1. one cron run → the ACTIVE HR/ACCOUNTANT get a PENDING salary and the
 *      ARCHIVED ones get NO row at all (the defect: they got one every month,
 *      because archiving neither zeroes `monthlySalary` nor changes the role);
 *   2. `createSalary` refuses an archived receiver;
 *   3. an ALREADY EXISTING PENDING salary of an archived receiver cannot be
 *      paid — this is the shape of the rows that accumulated on prod before the
 *      cron filter existed, and the reason the fix needs both halves.
 *
 * Scratch DB only — NEVER crm_db. The URL comes from `apps/api/.env.test`
 * (which already points at the scratch database), so no connection string is
 * spelled out here — a doc-comment credential is the kind of line that gets
 * copy-pasted into a prod script:
 *   pnpm --filter @crm/api exec vitest run salary-archived-receiver.integration.spec
 */
import { Global, Module } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { drizzle } from 'drizzle-orm/node-postgres'
import { and, eq, inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'

import { DatabaseService } from '../database/database.service'
import { TransactionsService } from './transactions.service'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'
import type { InvoicesService } from '../invoices/invoices.service'
import { transactions, users } from '../database/schema'
import * as schema from '../database/schema'

// Far-future month: no live cron data or other spec can collide with it.
const MONTH = '2099-11'

const ADMIN_ID = 'fc700000-0000-4000-aa00-000000000001'
const ACTIVE_HR_ID = 'fc700000-0000-4000-aa00-000000000002'
const ARCHIVED_HR_ID = 'fc700000-0000-4000-aa00-000000000003'
const ARCHIVED_ACCT_ID = 'fc700000-0000-4000-aa00-000000000004'
const MY_USER_IDS = [ADMIN_ID, ACTIVE_HR_ID, ARCHIVED_HR_ID, ARCHIVED_ACCT_ID]

const ADMIN_USER: SessionUser = {
  id: ADMIN_ID,
  role: 'ADMIN',
  displayName: 'Wave1 Admin',
  email: 'wave1-admin@test.spec',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 26,
}

const stubInvoices = {
  autoCreateForSalary: () => Promise.resolve(),
} as unknown as InvoicesService

let _pool: Pool | null = null
let dbAvailable = true

@Global()
@Module({
  providers: [
    {
      provide: DatabaseService,
      useFactory: (): DatabaseService => {
        _pool = new Pool({ connectionString: process.env['DATABASE_URL'], max: 5 })
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
        makeTransactionsService({ db, invoicesService: stubInvoices }),
      inject: [DatabaseService],
    },
  ],
})
class ArchivedReceiverTestModule {}

describe('salary — archived receiver barrier (E-1, real DB)', () => {
  let svc: TransactionsService
  let dbSvc: DatabaseService

  // Scoped by the far-future sentinel month ALONE: `createMonthlySalaries` is a
  // COMPANY-WIDE cron and also inserts rows for whatever real employees the
  // scratch DB happens to carry (see the same reasoning in
  // salary-cron-idempotency.integration.spec.ts). The month is spec-unique, so
  // this deletes everything these runs created and nothing else.
  async function cleanup() {
    await dbSvc.db.delete(transactions).where(eq(transactions.salaryMonth, MONTH))
  }

  async function salaryRowsFor(receiverId: string) {
    return dbSvc.db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.type, 'SALARY'),
          eq(transactions.receiverId, receiverId),
          eq(transactions.salaryMonth, MONTH),
        ),
      )
  }

  beforeAll(async () => {
    try {
      const probe = new Pool({ connectionString: process.env['DATABASE_URL'] })
      await probe.query('SELECT 1')
      await probe.end()
    } catch {
      console.warn('[salary-archived-receiver] SKIPPED — no DB reachable at DATABASE_URL')
      dbAvailable = false
      return
    }

    const moduleRef = await Test.createTestingModule({
      imports: [ArchivedReceiverTestModule],
    }).compile()
    await moduleRef.init()
    svc = moduleRef.get(TransactionsService)
    dbSvc = moduleRef.get(DatabaseService)

    await cleanup()
    await dbSvc.db.delete(users).where(inArray(users.id, MY_USER_IDS))

    // The cron needs SOME admin as the `createdBy` author; this spec brings its
    // own throwaway one rather than touching the shared canonical MAKSYM_ID.
    await dbSvc.db.insert(users).values([
      {
        id: ADMIN_ID,
        email: 'wave1-admin@test.spec',
        displayName: 'Wave1 Admin',
        role: 'ADMIN',
        googleId: `test-google-${ADMIN_ID}`,
      },
      {
        id: ACTIVE_HR_ID,
        email: 'wave1-hr-active@test.spec',
        displayName: 'Wave1 HR active',
        role: 'HR',
        monthlySalary: '1500',
        googleId: `test-google-${ACTIVE_HR_ID}`,
      },
      {
        // Archived EXACTLY as UsersService.archive leaves them: `archivedAt`
        // stamped, role untouched, `monthlySalary` still set. That combination
        // is what the role-only SELECT kept matching.
        id: ARCHIVED_HR_ID,
        email: 'wave1-hr-archived@test.spec',
        displayName: 'Wave1 HR archived',
        role: 'HR',
        monthlySalary: '1500',
        archivedAt: new Date('2026-01-31T00:00:00.000Z'),
        googleId: `test-google-${ARCHIVED_HR_ID}`,
      },
      {
        id: ARCHIVED_ACCT_ID,
        email: 'wave1-acct-archived@test.spec',
        displayName: 'Wave1 Accountant archived',
        role: 'ACCOUNTANT',
        monthlySalary: '2000',
        archivedAt: new Date('2026-02-28T00:00:00.000Z'),
        googleId: `test-google-${ARCHIVED_ACCT_ID}`,
      },
    ])
  }, 30_000)

  afterAll(async () => {
    if (!dbAvailable) return
    try {
      await cleanup()
      await dbSvc.db.delete(users).where(inArray(users.id, MY_USER_IDS))
    } catch {
      // non-fatal
    }
    await _pool?.end()
  }, 15_000)

  beforeEach(async () => {
    if (!dbAvailable) return
    await cleanup()
  })

  it('AC1: the cron pays the active employee and skips the archived ones', async () => {
    if (!dbAvailable) return

    await svc.createMonthlySalaries(MONTH)

    expect(await salaryRowsFor(ACTIVE_HR_ID)).toHaveLength(1)
    expect(await salaryRowsFor(ARCHIVED_HR_ID)).toHaveLength(0)
    expect(await salaryRowsFor(ARCHIVED_ACCT_ID)).toHaveLength(0)
  }, 30_000)

  it('AC2: createSalary refuses an archived receiver', async () => {
    if (!dbAvailable) return

    await expect(
      svc.createSalary(
        { receiverId: ARCHIVED_HR_ID, amount: 1500, salaryMonth: MONTH },
        ADMIN_USER,
      ),
    ).rejects.toThrow('Получатель архивирован — зарплата не начисляется')

    expect(await salaryRowsFor(ARCHIVED_HR_ID)).toHaveLength(0)
  }, 30_000)

  it('AC2: an already-accumulated PENDING salary of an archived receiver cannot be paid', async () => {
    if (!dbAvailable) return

    // Insert the row the way the cron did BEFORE the filter existed — the exact
    // shape of the rows that may already sit on prod.
    const [row] = await dbSvc.db
      .insert(transactions)
      .values({
        type: 'SALARY',
        status: 'PENDING',
        amount: '1500',
        currency: 'USD',
        senderId: null,
        senderLabel: 'CheekyCheeseIT',
        receiverId: ARCHIVED_HR_ID,
        salaryMonth: MONTH,
        fundingSource: null,
        createdBy: ADMIN_ID,
      })
      .returning()

    await expect(
      svc.paySalary(
        row!.id,
        {
          fundingSource: 'COMPANY_ACCOUNT',
          currency: 'USDT',
          receiptExternalUrl: 'https://etherscan.io/tx/0x' + 'a'.repeat(64),
        },
        ADMIN_USER,
      ),
    ).rejects.toThrow('Получатель зарплаты архивирован — выплата невозможна')

    // Still PENDING — nothing was paid, no balance moved.
    const after = await salaryRowsFor(ARCHIVED_HR_ID)
    expect(after).toHaveLength(1)
    expect(after[0]!.status).toBe('PENDING')
  }, 30_000)
})
