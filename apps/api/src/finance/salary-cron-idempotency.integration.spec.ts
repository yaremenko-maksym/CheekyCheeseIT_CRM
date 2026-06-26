import { Global, Module } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { drizzle } from 'drizzle-orm/node-postgres'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MAKSYM_ID } from '@crm/shared'

import { DatabaseService } from '../database/database.service'
import { TransactionsService } from './transactions.service'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'
import type { InvoicesService } from '../invoices/invoices.service'
import { transactions, users } from '../database/schema'
import * as schema from '../database/schema'

/**
 * Audit 2026-06-27 (LOW #5) — salary-cron IDEMPOTENCY (real DB).
 *
 * createMonthlySalaries previously did a find-then-insert ("skip if exists")
 * with a TOCTOU gap: a concurrent / re-run cron could insert a SECOND SALARY for
 * the same (receiver, month). The fix adds a partial unique index
 * `uq_transactions_salary_receiver_month` (WHERE type='SALARY' AND salary_month
 * IS NOT NULL) and switches the inserts to `ON CONFLICT DO NOTHING` — the DB is
 * the single source of truth for "already created".
 *
 * Asserts against REAL PostgreSQL (crm_qa scratch — NEVER crm_db):
 *   1. A single cron run creates exactly one PENDING salary per eligible employee.
 *   2. Re-running the cron for the SAME month creates NO duplicates (idempotent).
 *   3. Two concurrent cron runs for the same month → still exactly one row each.
 *
 * The cron only proceeds when an ADMIN with the canonical MAKSYM_ID exists (it is
 * the `createdBy` author), so we seed that admin id (imported from @crm/shared).
 *
 * Run against the scratch DB:
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_qa \
 *     pnpm --filter @crm/api test -- salary-cron-idempotency.integration
 */

const MONTH = '2099-12' // far-future month so no live cron data collides

const HR_EMP_ID = 'fc600000-0000-4000-aa00-000000000002'
const ACCT_ID = 'fc600000-0000-4000-aa00-000000000003'
// MAKSYM_ID is the SHARED canonical admin id (other specs / seed reference it,
// e.g. contract_templates.created_by) — we only UPSERT it, NEVER delete it.
// MY_USER_IDS are this spec's own throwaway users, safe to delete.
const MY_USER_IDS = [HR_EMP_ID, ACCT_ID]

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
class SalaryCronTestModule {}

describe('salary cron — idempotency via partial unique index (LOW #5, real DB)', () => {
  let svc: TransactionsService
  let dbSvc: DatabaseService

  // Scope cleanup to salaries RECEIVED by this spec's own users for the test
  // month. We must NOT delete by `createdBy = MAKSYM_ID` — the cron stamps EVERY
  // salary (incl. other specs' employees on the shared crm_qa) with MAKSYM_ID as
  // author, so a broad createdBy delete would wipe unrelated rows.
  async function cleanup() {
    await dbSvc.db
      .delete(transactions)
      .where(
        and(eq(transactions.salaryMonth, MONTH), inArray(transactions.receiverId, MY_USER_IDS)),
      )
  }

  async function countSalaries(receiverId: string): Promise<number> {
    const rows = await dbSvc.db
      .select({ c: sql<string>`COUNT(*)` })
      .from(transactions)
      .where(
        and(
          eq(transactions.type, 'SALARY'),
          eq(transactions.receiverId, receiverId),
          eq(transactions.salaryMonth, MONTH),
        ),
      )
    return parseInt(rows[0]?.c ?? '0', 10)
  }

  beforeAll(async () => {
    try {
      const probe = new Pool({ connectionString: process.env['DATABASE_URL'] })
      await probe.query('SELECT 1')
      const idx = await probe.query(
        `SELECT indexname FROM pg_indexes WHERE tablename='transactions' AND indexname='uq_transactions_salary_receiver_month' LIMIT 1`,
      )
      await probe.end()
      if (idx.rowCount === 0) {
        console.warn(
          '[salary-cron-idempotency] SKIPPED — uq_transactions_salary_receiver_month index missing (run db:push)',
        )
        dbAvailable = false
        return
      }
    } catch {
      console.warn('[salary-cron-idempotency] SKIPPED — no DB reachable at DATABASE_URL')
      dbAvailable = false
      return
    }

    const moduleRef = await Test.createTestingModule({ imports: [SalaryCronTestModule] }).compile()
    await moduleRef.init()
    svc = moduleRef.get(TransactionsService)
    dbSvc = moduleRef.get(DatabaseService)

    const db = dbSvc.db
    await cleanup()
    // Only delete THIS spec's throwaway users — never MAKSYM_ID (shared canonical
    // id referenced by seed/other specs, e.g. contract_templates.created_by).
    await db.delete(users).where(inArray(users.id, MY_USER_IDS))

    // Ensure the canonical MAKSYM_ID admin exists AND is an active ADMIN (the cron
    // gates on `role='ADMIN' AND id=MAKSYM_ID`). Upsert so a pre-seeded crm_qa row
    // is normalised to ADMIN/unarchived without deleting it.
    await db
      .insert(users)
      .values({
        id: MAKSYM_ID,
        email: 'cron-maksym@test.spec',
        displayName: 'Cron Maksym',
        role: 'ADMIN',
        googleId: `test-google-${MAKSYM_ID}`,
      })
      .onConflictDoUpdate({
        target: users.id,
        set: { role: 'ADMIN', archivedAt: null },
      })

    // This spec's own salaried employees.
    await db
      .insert(users)
      .values([
        {
          id: HR_EMP_ID,
          email: 'cron-hr@test.spec',
          displayName: 'Cron HR',
          role: 'HR',
          monthlySalary: '1500',
          googleId: `test-google-${HR_EMP_ID}`,
        },
        {
          id: ACCT_ID,
          email: 'cron-acct@test.spec',
          displayName: 'Cron Acct',
          role: 'ACCOUNTANT',
          monthlySalary: '2000',
          googleId: `test-google-${ACCT_ID}`,
        },
      ])
      .onConflictDoNothing()
  }, 30_000)

  afterAll(async () => {
    if (!dbAvailable) return
    try {
      await cleanup()
      // Only delete this spec's throwaway users; leave MAKSYM_ID intact.
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

  it('single run → exactly one PENDING salary per eligible employee', async () => {
    if (!dbAvailable) return
    await svc.createMonthlySalaries(MONTH)
    expect(await countSalaries(HR_EMP_ID)).toBe(1)
    expect(await countSalaries(ACCT_ID)).toBe(1)
  }, 30_000)

  it('re-running the SAME month creates NO duplicates (idempotent)', async () => {
    if (!dbAvailable) return
    await svc.createMonthlySalaries(MONTH)
    await svc.createMonthlySalaries(MONTH)
    await svc.createMonthlySalaries(MONTH)
    expect(await countSalaries(HR_EMP_ID)).toBe(1)
    expect(await countSalaries(ACCT_ID)).toBe(1)
  }, 30_000)

  it('two concurrent cron runs for the same month → still exactly one row each', async () => {
    if (!dbAvailable) return
    // Race two cron runs. With the find-then-insert TOCTOU both could insert; the
    // ON CONFLICT DO NOTHING against the partial unique index guarantees at most
    // one row per (receiver, month) regardless of interleaving.
    await Promise.all([svc.createMonthlySalaries(MONTH), svc.createMonthlySalaries(MONTH)])
    expect(await countSalaries(HR_EMP_ID)).toBe(1)
    expect(await countSalaries(ACCT_ID)).toBe(1)
  }, 30_000)
})
