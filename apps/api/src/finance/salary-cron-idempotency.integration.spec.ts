import { randomUUID } from 'node:crypto'
import { Global, Module } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { drizzle } from 'drizzle-orm/node-postgres'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MAKSYM_ID, type SessionUser } from '@crm/shared'

import { DatabaseService } from '../database/database.service'
import { TransactionsService } from './transactions.service'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'
import type { InvoicesService } from '../invoices/invoices.service'
import { salaryMonthInitializations, transactions, users } from '../database/schema'
import * as schema from '../database/schema'
import { hasDatabaseUrl } from '../test/require-real-db'

/**
 * Multipart salary + salary-cron idempotency (real DB).
 *
 * Multiple SALARY rows for one receiver/month are valid concrete payment parts.
 * Cron idempotency therefore lives in salary_month_initializations instead of a
 * uniqueness constraint on transactions.
 *
 * Asserts against REAL PostgreSQL (crm_qa scratch — NEVER crm_db):
 *   1. Manual same-month salary parts can coexist.
 *   2. Cron still creates exactly one automatic component per receiver/month.
 *   3. Legacy NULL-origin rows are adopted without duplication.
 *   4. Re-running / concurrent cron calls remain idempotent.
 *   5. The durable marker prevents deleted automatic history from resurrecting.
 *
 * The cron proceeds when ANY ADMIN exists (audit 2026-06-28 #7 — it no longer
 * requires the canonical MAKSYM_ID; the resolved admin is only the `createdBy`
 * author). We seed MAKSYM_ID as an ADMIN here so the cron has an author; the
 * "non-MAKSYM admin still works" + "no admin → no-op" paths are pinned by the
 * unit spec transactions.finance-audit.spec.ts.
 *
 * Run against the scratch DB:
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_qa \
 *     pnpm --filter @crm/api test -- salary-cron-idempotency.integration
 */

const MONTH = '2099-12' // far-future month so no live cron data collides
const MOVE_MONTH = '2099-11'

const HR_EMP_ID = 'fc600000-0000-4000-aa00-000000000002'
const ACCT_ID = 'fc600000-0000-4000-aa00-000000000003'
// MAKSYM_ID is the SHARED canonical admin id (other specs / seed reference it,
// e.g. contract_templates.created_by) — we only UPSERT it, NEVER delete it.
// MY_USER_IDS are this spec's own throwaway users, safe to delete.
const MY_USER_IDS = [HR_EMP_ID, ACCT_ID]
const ADMIN_ACTOR: SessionUser = {
  id: MAKSYM_ID,
  email: 'cron-maksym@test.spec',
  displayName: 'Cron Maksym',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 0,
  locale: 'uk',
  legalFullName: null,
}

const stubInvoices = {
  autoCreateForSalary: () => Promise.resolve(),
} as unknown as InvoicesService

let _pool: Pool | null = null

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

describe.skipIf(!hasDatabaseUrl())(
  'salary cron — multipart salary + durable cron idempotency (real DB)',
  () => {
    let svc: TransactionsService
    let dbSvc: DatabaseService

    // Scope cleanup by `salaryMonth = MONTH` ALONE (no receiverId filter).
    //
    // WHY (residue bug, task-integration-spec-cleanup): `createMonthlySalaries`
    // is a COMPANY-WIDE cron — it inserts a PENDING SALARY row for EVERY eligible
    // employee with `monthlySalary` set, not just this spec's own 2 throwaway
    // users. The original cleanup only deleted `receiverId IN MY_USER_IDS`,
    // silently leaving 9 orphaned SALARY/2099-12 rows behind for real seeded
    // HR/ACCOUNTANT/JUNIOR employees on every run (confirmed empirically via a
    // before/after row-count diff on crm_qa).
    //
    // The far-future sentinel `MONTH = '2099-12'` (see const above) is already
    // spec-unique — no other spec or real cron would ever use it — so scoping
    // the delete to `salaryMonth = MONTH` alone is both SAFE (touches nothing
    // else) and COMPLETE (removes every row this spec's cron calls created,
    // company-wide, not just its own 2 fixtures). We must NOT delete by
    // `createdBy = MAKSYM_ID` — the cron stamps EVERY salary with MAKSYM_ID as
    // author, so that filter would still be too broad across real months.
    async function cleanup() {
      await dbSvc.db
        .delete(salaryMonthInitializations)
        .where(inArray(salaryMonthInitializations.salaryMonth, [MONTH, MOVE_MONTH]))
      await dbSvc.db
        .delete(transactions)
        .where(inArray(transactions.salaryMonth, [MONTH, MOVE_MONTH]))
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

    async function countInitializations(receiverId: string, month = MONTH): Promise<number> {
      const rows = await dbSvc.db
        .select({ c: sql<string>`COUNT(*)` })
        .from(salaryMonthInitializations)
        .where(
          and(
            eq(salaryMonthInitializations.receiverId, receiverId),
            eq(salaryMonthInitializations.salaryMonth, month),
          ),
        )
      return parseInt(rows[0]?.c ?? '0', 10)
    }

    beforeAll(async () => {
      try {
        const probe = new Pool({ connectionString: process.env['DATABASE_URL'] })
        await probe.query('SELECT 1')
        const markerTable = await probe.query(
          `SELECT to_regclass('public.salary_month_initializations') AS table_name`,
        )
        const newIdx = await probe.query(
          `SELECT indexname FROM pg_indexes WHERE tablename='transactions' AND indexname='idx_transactions_salary_receiver_month' LIMIT 1`,
        )
        const oldIdx = await probe.query(
          `SELECT indexname FROM pg_indexes WHERE tablename='transactions' AND indexname='uq_transactions_salary_receiver_month' LIMIT 1`,
        )
        const salaryIdempotencyIdx = await probe.query(
          `SELECT indexname FROM pg_indexes WHERE tablename='transactions' AND indexname='uq_transactions_salary_idempotency_key' LIMIT 1`,
        )
        await probe.end()
        if (
          !markerTable.rows[0]?.table_name ||
          newIdx.rowCount === 0 ||
          oldIdx.rowCount !== 0 ||
          salaryIdempotencyIdx.rowCount === 0
        ) {
          throw new Error(
            '[salary-cron-idempotency] FAILED — multipart salary schema missing (run db:push on scratch DB)',
          )
        }
      } catch {
        throw new Error('[salary-cron-idempotency] FAILED — no DB reachable at DATABASE_URL')
      }

      const moduleRef = await Test.createTestingModule({
        imports: [SalaryCronTestModule],
      }).compile()
      await moduleRef.init()
      svc = moduleRef.get(TransactionsService)
      dbSvc = moduleRef.get(DatabaseService)

      const db = dbSvc.db
      await cleanup()
      // Only delete THIS spec's throwaway users — never MAKSYM_ID (shared canonical
      // id referenced by seed/other specs, e.g. contract_templates.created_by).
      await db.delete(users).where(inArray(users.id, MY_USER_IDS))

      // Ensure an active ADMIN exists so the cron has a `createdBy` author (audit
      // 2026-06-28 #7: it resolves ANY admin now, not specifically MAKSYM_ID). We
      // upsert MAKSYM_ID as that admin so a pre-seeded crm_qa row is normalised to
      // ADMIN/unarchived without deleting it.
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
      await cleanup()
    })

    it('manual createSalary allows multiple parts without claiming cron initialization', async () => {
      await svc.createSalary(
        {
          receiverId: HR_EMP_ID,
          amount: 500,
          currency: 'USD',
          salaryMonth: MONTH,
          idempotencyKey: randomUUID(),
        },
        ADMIN_ACTOR,
      )
      await svc.createSalary(
        {
          receiverId: HR_EMP_ID,
          amount: 500,
          currency: 'USD',
          salaryMonth: MONTH,
          idempotencyKey: randomUUID(),
        },
        ADMIN_ACTOR,
      )

      expect(await countSalaries(HR_EMP_ID)).toBe(2)
      expect(await countInitializations(HR_EMP_ID)).toBe(0)
    }, 30_000)

    it('manual createSalary replays the same idempotency key without creating a duplicate', async () => {
      const idempotencyKey = randomUUID()
      const payload = {
        receiverId: HR_EMP_ID,
        amount: 500,
        currency: 'USD' as const,
        salaryMonth: MONTH,
        idempotencyKey,
      }

      const first = await svc.createSalary(payload, ADMIN_ACTOR)
      const replay = await svc.createSalary(payload, ADMIN_ACTOR)

      expect(replay.id).toBe(first.id)
      expect(await countSalaries(HR_EMP_ID)).toBe(1)
      expect(await countInitializations(HR_EMP_ID)).toBe(0)
    }, 30_000)

    it('concurrent manual retries with one idempotency key create exactly one salary part', async () => {
      const idempotencyKey = randomUUID()
      const payload = {
        receiverId: HR_EMP_ID,
        amount: 500,
        currency: 'USD' as const,
        salaryMonth: MONTH,
        idempotencyKey,
      }

      const [a, b] = await Promise.all([
        svc.createSalary(payload, ADMIN_ACTOR),
        svc.createSalary(payload, ADMIN_ACTOR),
      ])

      expect(a.id).toBe(b.id)
      expect(await countSalaries(HR_EMP_ID)).toBe(1)
    }, 30_000)

    it('identical manual salary parts remain legal when they carry different intent keys', async () => {
      const base = {
        receiverId: HR_EMP_ID,
        amount: 500,
        currency: 'USD' as const,
        salaryMonth: MONTH,
      }

      const first = await svc.createSalary({ ...base, idempotencyKey: randomUUID() }, ADMIN_ACTOR)
      const second = await svc.createSalary({ ...base, idempotencyKey: randomUUID() }, ADMIN_ACTOR)

      expect(second.id).not.toBe(first.id)
      expect(await countSalaries(HR_EMP_ID)).toBe(2)
    }, 30_000)

    it('manual part first, then cron keeps it and adds exactly one automatic part', async () => {
      await svc.createSalary(
        {
          receiverId: HR_EMP_ID,
          amount: 111,
          currency: 'EUR',
          salaryMonth: MONTH,
          idempotencyKey: randomUUID(),
        },
        ADMIN_ACTOR,
      )

      await svc.createMonthlySalaries(MONTH)

      const rows = await dbSvc.db.query.transactions.findMany({
        where: and(
          eq(transactions.type, 'SALARY'),
          eq(transactions.receiverId, HR_EMP_ID),
          eq(transactions.salaryMonth, MONTH),
        ),
      })
      expect(rows).toHaveLength(2)
      expect(
        rows.some(
          (row) =>
            Number(row.amount) === 111 && row.currency === 'EUR' && row.salaryOrigin === 'MANUAL',
        ),
      ).toBe(true)
      expect(
        rows.some(
          (row) =>
            Number(row.amount) === 1500 && row.currency === 'USD' && row.salaryOrigin === 'CRON',
        ),
      ).toBe(true)
      expect(await countInitializations(HR_EMP_ID)).toBe(1)
    }, 30_000)

    it('DB rejects a keyless MANUAL salary while legacy/CRON keyless rows remain valid', async () => {
      await expect(
        dbSvc.db.insert(transactions).values({
          type: 'SALARY',
          status: 'PENDING',
          amount: '500',
          currency: 'USD',
          senderLabel: 'CheekyCheeseIT',
          receiverId: HR_EMP_ID,
          salaryMonth: MONTH,
          salaryOrigin: 'MANUAL',
          idempotencyKey: null,
          createdBy: MAKSYM_ID,
        }),
      ).rejects.toMatchObject({
        cause: {
          code: '23514',
          constraint: 'ck_transactions_manual_salary_idempotency_key',
        },
      })
    }, 30_000)

    it('legacy NULL-origin salary prevents a post-upgrade cron duplicate and seeds the marker', async () => {
      await dbSvc.db.insert(transactions).values({
        type: 'SALARY',
        status: 'PAID',
        amount: '1500',
        currency: 'USD',
        senderLabel: 'CheekyCheeseIT',
        receiverId: HR_EMP_ID,
        salaryMonth: MONTH,
        salaryOrigin: null,
        createdBy: MAKSYM_ID,
      })

      await svc.createMonthlySalaries(MONTH)

      expect(await countSalaries(HR_EMP_ID)).toBe(1)
      expect(await countInitializations(HR_EMP_ID)).toBe(1)
    }, 30_000)

    it('cron first, then a manual part keeps both rows', async () => {
      await svc.createMonthlySalaries(MONTH)
      await svc.createSalary(
        {
          receiverId: HR_EMP_ID,
          amount: 333,
          currency: 'USD',
          salaryMonth: MONTH,
          idempotencyKey: randomUUID(),
        },
        ADMIN_ACTOR,
      )

      expect(await countSalaries(HR_EMP_ID)).toBe(2)
      expect(await countInitializations(HR_EMP_ID)).toBe(1)
    }, 30_000)

    it('single run → exactly one PENDING salary per eligible employee', async () => {
      await svc.createMonthlySalaries(MONTH)
      expect(await countSalaries(HR_EMP_ID)).toBe(1)
      expect(await countSalaries(ACCT_ID)).toBe(1)
    }, 30_000)

    it('re-running the SAME month creates NO duplicates (idempotent)', async () => {
      await svc.createMonthlySalaries(MONTH)
      await svc.createMonthlySalaries(MONTH)
      await svc.createMonthlySalaries(MONTH)
      expect(await countSalaries(HR_EMP_ID)).toBe(1)
      expect(await countSalaries(ACCT_ID)).toBe(1)
    }, 30_000)

    it('two concurrent cron runs for the same month → still exactly one row each', async () => {
      // The unique marker claim and automatic row insertion share one DB
      // transaction, so only one contender can create the cron-owned part.
      await Promise.all([svc.createMonthlySalaries(MONTH), svc.createMonthlySalaries(MONTH)])
      expect(await countSalaries(HR_EMP_ID)).toBe(1)
      expect(await countSalaries(ACCT_ID)).toBe(1)
    }, 30_000)

    it('manual part plus concurrent cron runs still creates exactly one automatic part', async () => {
      await svc.createSalary(
        {
          receiverId: HR_EMP_ID,
          amount: 222,
          currency: 'USD',
          salaryMonth: MONTH,
          idempotencyKey: randomUUID(),
        },
        ADMIN_ACTOR,
      )

      await Promise.all([
        svc.createMonthlySalaries(MONTH),
        svc.createMonthlySalaries(MONTH),
        svc.createMonthlySalaries(MONTH),
      ])

      expect(await countSalaries(HR_EMP_ID)).toBe(2)
      expect(await countInitializations(HR_EMP_ID)).toBe(1)
    }, 30_000)

    it('keeps initialization after salary deletion so cron does not resurrect history', async () => {
      await svc.createMonthlySalaries(MONTH)
      expect(await countSalaries(HR_EMP_ID)).toBe(1)

      await dbSvc.db
        .delete(transactions)
        .where(
          and(
            eq(transactions.type, 'SALARY'),
            eq(transactions.receiverId, HR_EMP_ID),
            eq(transactions.salaryMonth, MONTH),
          ),
        )
      expect(await countSalaries(HR_EMP_ID)).toBe(0)

      await svc.createMonthlySalaries(MONTH)
      expect(await countSalaries(HR_EMP_ID)).toBe(0)
      expect(await countInitializations(HR_EMP_ID)).toBe(1)
    }, 30_000)

    it('moving an unpaid cron salary moves its marker and frees the old month for cron', async () => {
      await svc.createMonthlySalaries(MONTH)
      const automatic = await dbSvc.db.query.transactions.findFirst({
        where: and(
          eq(transactions.type, 'SALARY'),
          eq(transactions.receiverId, HR_EMP_ID),
          eq(transactions.salaryMonth, MONTH),
          eq(transactions.salaryOrigin, 'CRON'),
        ),
      })
      expect(automatic).toBeDefined()
      expect(await countInitializations(HR_EMP_ID, MONTH)).toBe(1)

      await svc.adminUpdateTransaction(automatic!.id, { salaryMonth: MOVE_MONTH }, ADMIN_ACTOR)

      expect(await countSalaries(HR_EMP_ID)).toBe(0)
      expect(await countInitializations(HR_EMP_ID, MONTH)).toBe(0)
      expect(await countInitializations(HR_EMP_ID, MOVE_MONTH)).toBe(1)

      await svc.createMonthlySalaries(MONTH)
      expect(await countSalaries(HR_EMP_ID)).toBe(1)
      expect(await countInitializations(HR_EMP_ID, MONTH)).toBe(1)
    }, 30_000)
  },
)
