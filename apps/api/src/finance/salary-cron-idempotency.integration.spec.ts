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
 *   2. Cron creates at most one automatic component per receiver/month — and
 *      NONE at all once the month is claimed, which since owner decision D-3
 *      (SR-795-M-1) a manual part does too. Before D-3 cron added its own row
 *      regardless, which is how one person and one month ended up with two
 *      independently payable salaries.
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

    it('manual createSalary allows multiple parts; the FIRST one claims the month (SR-795-M-1)', async () => {
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
      // Owner decision D-3: one marker for the month, claimed by the first
      // part. The second part finds it taken and is recorded anyway — several
      // parts per employee/month is the whole point of the feature.
      expect(await countInitializations(HR_EMP_ID)).toBe(1)
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
      expect(await countInitializations(HR_EMP_ID)).toBe(1)
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

    // SR-795-M-1, the headline case, on a real database. This spec previously
    // asserted the DEFECT as the contract: a manual part followed by cron left
    // TWO payable salaries for one person and one month (111 EUR by hand plus
    // 1500 USD from the cron), each payable on its own through paySalary, with
    // nothing anywhere saying the other existed. Manual QA reproduced the
    // double payment on a real stack. Owner decision D-3: the manual part owns
    // the month, so cron skips it — the operator's own figure stands, and the
    // ledger carries exactly what was intended.
    it('manual part first → cron adds NOTHING for that month (SR-795-M-1)', async () => {
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
      // Backfill re-invokes the cron for the same month and is the other half of
      // the measured defect: an ADMIN pressing it was enough to mint the second
      // salary. It must be just as inert.
      await svc.backfillSalaryMonth(ADMIN_ACTOR, MONTH)

      const rows = await dbSvc.db.query.transactions.findMany({
        where: and(
          eq(transactions.type, 'SALARY'),
          eq(transactions.receiverId, HR_EMP_ID),
          eq(transactions.salaryMonth, MONTH),
        ),
      })
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        salaryOrigin: 'MANUAL',
        currency: 'EUR',
        status: 'PENDING',
      })
      expect(Number(rows[0]!.amount)).toBe(111)
      // Total payable for the month is the 111 EUR that was entered — not that
      // plus an automatic 1500 USD nobody asked for.
      expect(rows.reduce((sum, row) => sum + Number(row.amount), 0)).toBe(111)
      expect(await countInitializations(HR_EMP_ID)).toBe(1)
    }, 30_000)

    // The other direction is unchanged and stays legal: once cron owns the
    // month, an operator may still record extra parts (that is the feature).
    it('the gap report stops advertising a month a manual part already covers', async () => {
      const before = await svc.getSalaryMonthGapReport(ADMIN_ACTOR, MONTH)
      expect(before.missing.map((r) => r.userId)).toContain(HR_EMP_ID)

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

      const after = await svc.getSalaryMonthGapReport(ADMIN_ACTOR, MONTH)
      expect(after.missing.map((r) => r.userId)).not.toContain(HR_EMP_ID)
    }, 30_000)

    // CR-M-3. The marker claim and the row insert share one transaction, and
    // until now nothing could break that: splitting the row back onto the pool
    // left every assertion green. It matters more than its severity suggests —
    // a claimed marker with no row behind it makes cron skip a month that has
    // no salary in it, which is the mirror image of the defect this whole task
    // fixes, and it would be silent in exactly the same way.
    //
    // A real database is the only place the guarantee exists, so the row insert
    // is made to fail where no application code can intercept it: a BEFORE
    // INSERT trigger that raises on a sentinel. Scratch database only, and
    // dropped in `finally` whatever happens.
    //
    // The function is created in `public`, not in `pg_temp` — a temp-schema
    // object belongs to one session and this runs over a pool, so a trigger
    // could not reliably reach it. It was named `pg_temp_…` at first, which
    // said the opposite of where it lives; the name now says what it is.
    it('a failed row insert leaves no marker behind (one transaction, not two)', async () => {
      await dbSvc.db.execute(sql`
        CREATE OR REPLACE FUNCTION cr_m_3_fault_injection_fn() RETURNS trigger AS $fn$
        BEGIN
          IF NEW.notes = 'CR-M-3 fault injection' THEN
            RAISE EXCEPTION 'injected failure after the marker claim';
          END IF;
          RETURN NEW;
        END
        $fn$ LANGUAGE plpgsql;
      `)
      await dbSvc.db.execute(sql`
        CREATE TRIGGER trg_cr_m_3_fault_injection
          BEFORE INSERT ON transactions
          FOR EACH ROW EXECUTE FUNCTION cr_m_3_fault_injection_fn();
      `)

      try {
        expect(await countInitializations(HR_EMP_ID)).toBe(0)

        // Drizzle wraps the driver error, so the injected text is on `cause` —
        // asserted rather than merely "it rejected", so the rejection cannot
        // come from something else and still pass.
        await expect(
          svc.createSalary(
            {
              receiverId: HR_EMP_ID,
              amount: 500,
              currency: 'USD',
              salaryMonth: MONTH,
              idempotencyKey: randomUUID(),
              notes: 'CR-M-3 fault injection',
            },
            ADMIN_ACTOR,
          ),
        ).rejects.toMatchObject({
          cause: { message: expect.stringContaining('injected failure after the marker claim') },
        })

        // The marker insert ran BEFORE the row insert, so it is only absent now
        // because the two share a transaction that rolled back together.
        expect(await countInitializations(HR_EMP_ID)).toBe(0)
        expect(await countSalaries(HR_EMP_ID)).toBe(0)

        // And the month is still accruable, which is the consequence that
        // actually matters: cron can mint the salary the failure denied.
        await svc.createMonthlySalaries(MONTH)
        expect(await countSalaries(HR_EMP_ID)).toBe(1)
      } finally {
        await dbSvc.db.execute(
          sql`DROP TRIGGER IF EXISTS trg_cr_m_3_fault_injection ON transactions`,
        )
        await dbSvc.db.execute(sql`DROP FUNCTION IF EXISTS cr_m_3_fault_injection_fn()`)
      }
    }, 30_000)

    // SR-795-L-2 on a real database: the idempotency index has no deleted_at
    // term, so the key survives the delete. What must not survive is the
    // wrong-success — a 200 naming a row every read path hides.
    it('a replay whose part was deleted is refused, not answered with the deleted id', async () => {
      const idempotencyKey = randomUUID()
      const payload = {
        receiverId: HR_EMP_ID,
        amount: 500,
        currency: 'USD' as const,
        salaryMonth: MONTH,
        idempotencyKey,
      }
      const created = await svc.createSalary(payload, ADMIN_ACTOR)
      await dbSvc.db
        .update(transactions)
        .set({ deletedAt: new Date() })
        .where(eq(transactions.id, created.id))

      await expect(svc.createSalary(payload, ADMIN_ACTOR)).rejects.toMatchObject({
        response: {
          code: 'FINANCE_SALARY_IDEMPOTENCY_CONFLICT',
          reason: 'DELETED_PART',
          existingTransactionId: created.id,
        },
      })
      // And nothing new was written behind the refusal: the deleted part is
      // still the only row for that receiver/month (countSalaries reads the raw
      // table, so it sees the soft-deleted row).
      expect(await countSalaries(HR_EMP_ID)).toBe(1)
    }, 30_000)

    // SR-795-L-3 on a real database: the TS union is not what refuses this —
    // the CHECK is. A typo stored here would fall out of BOTH the
    // automatic-component and the month-accounting predicates at once.
    it('DB refuses a salary_origin outside the shared domain', async () => {
      await expect(
        dbSvc.db.insert(transactions).values({
          type: 'SALARY',
          status: 'PENDING',
          amount: '500',
          currency: 'USD',
          senderLabel: 'CheekyCheeseIT',
          receiverId: HR_EMP_ID,
          salaryMonth: MONTH,
          salaryOrigin: 'Manual' as never,
          idempotencyKey: randomUUID(),
          createdBy: MAKSYM_ID,
        }),
      ).rejects.toMatchObject({
        cause: { code: '23514', constraint: 'ck_transactions_salary_origin_domain' },
      })
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

    // D-3: the manual part owns the month, so however many cron runs race for
    // it, none of them adds a row. The marker's unique claim is what serialises
    // them, exactly as it does between two cron runs.
    it('manual part plus concurrent cron runs leaves only the manual part', async () => {
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

      expect(await countSalaries(HR_EMP_ID)).toBe(1)
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

    // SR-795-M-3 (PR #868): moving an automatic salary into a month whose
    // marker is ALREADY claimed used to reclassify it as MANUAL, which the
    // keyless-MANUAL CHECK rejects — a 500 that made the correction impossible.
    // A real marker on the destination month is what exercises that branch.
    it('moving a cron salary into an already-initialized month succeeds and marks it ADJUSTED', async () => {
      await svc.createMonthlySalaries(MOVE_MONTH)
      expect(await countInitializations(HR_EMP_ID, MOVE_MONTH)).toBe(1)
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

      await svc.adminUpdateTransaction(automatic!.id, { salaryMonth: MOVE_MONTH }, ADMIN_ACTOR)

      const moved = await dbSvc.db.query.transactions.findFirst({
        where: eq(transactions.id, automatic!.id),
      })
      expect(moved).toMatchObject({ salaryMonth: MOVE_MONTH, salaryOrigin: 'ADJUSTED' })
      expect(moved!.idempotencyKey).toBeNull()
      // The destination keeps its single marker; the emptied source month is freed.
      expect(await countInitializations(HR_EMP_ID, MOVE_MONTH)).toBe(1)
      expect(await countInitializations(HR_EMP_ID, MONTH)).toBe(0)
    }, 30_000)
  },
)
