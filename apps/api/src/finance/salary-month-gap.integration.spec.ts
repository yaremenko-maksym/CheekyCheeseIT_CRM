import { Global, Module } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { JwtModule, JwtService } from '@nestjs/jwt'
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import cookie from '@fastify/cookie'
import { drizzle } from 'drizzle-orm/node-postgres'
import { and, eq, inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'

import { JwtAuthGuard } from '../auth/jwt.guard'
import { ROLES_KEY } from '../common/decorators/roles.decorator'
import { RolesGuard } from '../common/guards/roles.guard'
import { DatabaseService } from '../database/database.service'
import { FinanceSummaryController } from './transactions.controller'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'
import { TransactionsService } from './transactions.service'
import { NbuCurrencyService } from './nbu-currency.service'
import {
  projectFinanceSettings,
  projectMembers,
  projects,
  transactionAuditLog,
  transactions,
  users,
} from '../database/schema'
import * as schema from '../database/schema'
import { hasDatabaseUrl } from '../test/require-real-db'
import { previousSalaryMonthKey } from './salary-month.util'

/**
 * Salary-month gap report + backfill — task-salary-month-gap-and-status (E-5)
 * real-backend integration spec (real Postgres, no mocks).
 *
 * WHY (feedback_mocked_e2e_guards, recurred 3×): this is a COMPANY-WIDE
 * finance aggregate/mutation behind a guard — a mocked E2E gives false
 * confidence. What a UNIT spec (salary-month-gap.unit.spec.ts) structurally
 * cannot prove:
 *   - "existing" is read against REAL rows (not a canned array a stub hands
 *     back regardless of the WHERE it was given) — including a REAL
 *     soft-deleted row still blocking the unique index (security-review
 *     MED-1).
 *   - Idempotency is the REAL unique index + `ON CONFLICT DO NOTHING` —
 *     calling backfill TWICE for the same month must not create a duplicate
 *     row (a mocked insert always "succeeds" and can't disprove this).
 *   - RBAC is enforced by a REAL JwtAuthGuard + RolesGuard over real HTTP,
 *     not a unit stub.
 *   - The audit trail (security-review HIGH-1) is a REAL row in
 *     `transactionAuditLog`, not a captured mock argument.
 *
 * code-review (round on #589): mounts the REAL production
 * `FinanceSummaryController` — NOT a sentinel — so `getSalaryMonthGap` /
 * `backfillSalaryMonth`'s own bodies (the `salaryMonthGapQuerySchema.parse`
 * / `salaryMonthBackfillSchema.parse` calls, the exact service methods
 * invoked) are the code under test, not a re-declared lookalike. This works
 * here (unlike the OLDER senior-summary / income-compliance specs, whose own
 * comments still say "cannot be DI-mounted") because `FinanceSummaryController`
 * carries explicit `@Inject(...)` on every constructor param — the thing that
 * actually defeats vitest/esbuild's missing `design:paramtypes` metadata; see
 * `transactions.summary.roles-guard.spec.ts` for the pattern this mirrors.
 *
 * DB-SKIP-GUARD: describe.skipIf(!hasDatabaseUrl()) when DATABASE_URL is
 * unset (reports SKIPPED, never a silent "0 assertions passed").
 *
 * Run against the scratch crm_qa DB (NEVER crm_db):
 *   pnpm --filter @crm/api test -- salary-month-gap.integration
 */

const JWT_SECRET = 'salary-month-gap-integration-secret-32-chars'

// ── Personas — stable IDs namespaced to THIS spec ───────────────────────────
const ADMIN: SessionUser = {
  id: 'f1000000-0000-4000-aa00-000000000001',
  email: 'sal-gap-admin@test.spec',
  displayName: 'Sal Gap Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 26,
  legalFullName: null,
}
const ACCOUNTANT: SessionUser = {
  id: 'f1000000-0000-4000-aa00-000000000002',
  email: 'sal-gap-accountant@test.spec',
  displayName: 'Sal Gap Accountant',
  avatarUrl: null,
  role: 'ACCOUNTANT',
  seniorSharePercent: 0,
  legalFullName: null,
}
const SENIOR: SessionUser = {
  id: 'f1000000-0000-4000-aa00-000000000003',
  email: 'sal-gap-senior@test.spec',
  displayName: 'Sal Gap Senior',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}
// HR_MISSING — monthlySalary set, no SALARY row for the target month → the gap.
const HR_MISSING: SessionUser = {
  id: 'f1000000-0000-4000-aa00-000000000004',
  email: 'sal-gap-hr-missing@test.spec',
  displayName: 'Sal Gap HR Missing',
  avatarUrl: null,
  role: 'HR',
  seniorSharePercent: 0,
  legalFullName: null,
}
// HR_COVERED — monthlySalary set, an EXISTING row already covers the month.
const HR_COVERED: SessionUser = {
  id: 'f1000000-0000-4000-aa00-000000000005',
  email: 'sal-gap-hr-covered@test.spec',
  displayName: 'Sal Gap HR Covered',
  avatarUrl: null,
  role: 'HR',
  seniorSharePercent: 0,
  legalFullName: null,
}
// HR_UNCONFIGURED — no monthlySalary at all → legitimately never in the gap.
const HR_UNCONFIGURED: SessionUser = {
  id: 'f1000000-0000-4000-aa00-000000000006',
  email: 'sal-gap-hr-unconfigured@test.spec',
  displayName: 'Sal Gap HR Unconfigured',
  avatarUrl: null,
  role: 'HR',
  seniorSharePercent: 0,
  legalFullName: null,
}
const JUNIOR_MISSING: SessionUser = {
  id: 'f1000000-0000-4000-aa00-000000000007',
  email: 'sal-gap-junior-missing@test.spec',
  displayName: 'Sal Gap Junior Missing',
  avatarUrl: null,
  role: 'JUNIOR',
  seniorSharePercent: 0,
  legalFullName: null,
}
// security-review MED-1 — monthlySalary set; a SALARY row for TARGET_MONTH
// will be created then SOFT-DELETED, proving the report never re-advertises
// a receiver backfill cannot actually fix (the unique index has no
// deleted_at term, so the stale row still blocks a fresh INSERT).
const HR_SOFT_DELETED: SessionUser = {
  id: 'f1000000-0000-4000-aa00-000000000008',
  email: 'sal-gap-hr-soft-deleted@test.spec',
  displayName: 'Sal Gap HR Soft Deleted',
  avatarUrl: null,
  role: 'HR',
  seniorSharePercent: 0,
  legalFullName: null,
}
// security-review MED-2 — on TWO active projects at once, each with a
// DIFFERENT resolved amount (project override), proving the report counts
// them exactly ONCE (the FIRST membership in iteration order), not twice.
const JUNIOR_MULTI_PROJECT: SessionUser = {
  id: 'f1000000-0000-4000-aa00-000000000009',
  email: 'sal-gap-junior-multi@test.spec',
  displayName: 'Sal Gap Junior Multi',
  avatarUrl: null,
  role: 'JUNIOR',
  seniorSharePercent: 0,
  legalFullName: null,
}
// security-review HIGH-1 — dedicated persona for the actor-attribution +
// audit-log proof, kept ISOLATED from the other backfill test so it doesn't
// depend on cross-test execution order.
const HR_AUDIT_PROOF: SessionUser = {
  id: 'f1000000-0000-4000-aa00-00000000000a',
  email: 'sal-gap-hr-audit-proof@test.spec',
  displayName: 'Sal Gap HR Audit Proof',
  avatarUrl: null,
  role: 'HR',
  seniorSharePercent: 0,
  legalFullName: null,
}

const TEST_USER_IDS = [
  ADMIN.id,
  ACCOUNTANT.id,
  SENIOR.id,
  HR_MISSING.id,
  HR_COVERED.id,
  HR_UNCONFIGURED.id,
  JUNIOR_MISSING.id,
  HR_SOFT_DELETED.id,
  JUNIOR_MULTI_PROJECT.id,
  HR_AUDIT_PROOF.id,
]

const PROJ_JUNIOR = 'f2000000-0000-4000-bb00-000000000001'
const PROJ_JUNIOR_MULTI_A = 'f2000000-0000-4000-bb00-000000000002'
const PROJ_JUNIOR_MULTI_B = 'f2000000-0000-4000-bb00-000000000003'
const TEST_PROJECT_IDS = [PROJ_JUNIOR, PROJ_JUNIOR_MULTI_A, PROJ_JUNIOR_MULTI_B]

// Far-future month namespaced to this spec — never collides with other specs'
// fixtures or a real cron run.
const TARGET_MONTH = '2099-11'
// A DIFFERENT far-future month, used ONLY by the HIGH-1 audit-log test — kept
// separate from TARGET_MONTH so that test's backfill call is the FIRST ever
// company-wide backfill for HR_AUDIT_PROOF's (receiver, month) pair,
// independent of this file's OWN test execution order.
const AUDIT_MONTH = '2099-10'
const TX_HR_COVERED_SALARY = 'f3000000-0000-4000-cc00-000000000001'
const TX_HR_SOFT_DELETED_SALARY = 'f3000000-0000-4000-cc00-000000000002'
const TEST_TX_IDS = [TX_HR_COVERED_SALARY, TX_HR_SOFT_DELETED_SALARY]

// `NbuCurrencyService` is a REAL constructor dependency of
// `FinanceSummaryController` (its `exchange-rate` route) but nothing this
// spec calls touches it — a stub that throws if ever invoked keeps that
// contract honest without wiring a real NBU client.
const stubNbu = {
  getRates: () => {
    throw new Error('NbuCurrencyService must not be reached by this spec')
  },
} as unknown as NbuCurrencyService

// ── TestDatabaseModule (real Pool) ──────────────────────────────────────────
let _testPool: Pool | null = null

@Global()
@Module({
  providers: [
    {
      provide: DatabaseService,
      useFactory: (): DatabaseService => {
        _testPool = new Pool({ connectionString: process.env['DATABASE_URL'] })
        const db = drizzle(_testPool, { schema })
        const instance = Object.create(DatabaseService.prototype) as DatabaseService
        Object.assign(instance, { pool: _testPool, db })
        Object.defineProperty(instance, 'onModuleInit', {
          value: () => Promise.resolve(),
          writable: false,
          enumerable: false,
          configurable: true,
        })
        Object.defineProperty(instance, 'onModuleDestroy', {
          value: () => _testPool?.end() ?? Promise.resolve(),
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
  imports: [
    TestDatabaseModule,
    JwtModule.register({ secret: JWT_SECRET, signOptions: { expiresIn: '1h' } }),
  ],
  // code-review: the REAL production controller, not a sentinel — see the
  // module comment above for why this is possible here.
  controllers: [FinanceSummaryController],
  providers: [
    Reflector,
    {
      provide: TransactionsService,
      useFactory: (db: DatabaseService) => makeTransactionsService({ db }),
      inject: [DatabaseService],
    },
    { provide: NbuCurrencyService, useValue: stubNbu },
    {
      provide: APP_GUARD,
      useFactory: (jwtSvc: JwtService, reflector: Reflector) => new JwtAuthGuard(jwtSvc, reflector),
      inject: [JwtService, Reflector],
    },
  ],
})
class SalaryMonthGapTestModule {}

// ── Suite ───────────────────────────────────────────────────────────────────
describe.skipIf(!hasDatabaseUrl())(
  'salary-month-gap — real backend integration (real DB, no mocks)',
  () => {
    let app: NestFastifyApplication
    let jwt: JwtService
    let dbSvc: DatabaseService

    async function cleanup(db: DatabaseService['db']): Promise<void> {
      await db.delete(transactions).where(inArray(transactions.id, TEST_TX_IDS))
      await db.delete(projectMembers).where(inArray(projectMembers.projectId, TEST_PROJECT_IDS))
      await db.delete(projects).where(inArray(projects.id, TEST_PROJECT_IDS))
      await db.delete(users).where(inArray(users.id, TEST_USER_IDS))
    }

    beforeAll(async () => {
      try {
        const probePool = new Pool({ connectionString: process.env['DATABASE_URL'] })
        await probePool.query('SELECT 1')
        const schemaCheck = await probePool.query(
          `SELECT table_name FROM information_schema.tables
         WHERE table_name='projects' LIMIT 1`,
        )
        await probePool.end()
        if (schemaCheck.rowCount === 0) {
          throw new Error('[salary-month-gap integration] FAILED — projects table not found')
        }
      } catch {
        throw new Error(
          '[salary-month-gap integration] FAILED — no DB reachable at DATABASE_URL (expected in CI unit job)',
        )
      }

      // `.overrideGuard(RolesGuard)` — the class-level `@UseGuards(RolesGuard)`
      // on the REAL `FinanceSummaryController` makes Nest auto-instantiate
      // `RolesGuard` itself via DI, which fails under vitest/esbuild (no
      // `design:paramtypes` for `RolesGuard`'s plain constructor → injected
      // `Reflector` comes back `undefined` → `TypeError` at request time).
      // Mirrors `transactions.summary.roles-guard.spec.ts`'s own fix for the
      // exact same guard, on the exact same controller.
      const moduleRef = await Test.createTestingModule({
        imports: [SalaryMonthGapTestModule],
      })
        .overrideGuard(RolesGuard)
        .useValue(new RolesGuard(new Reflector()))
        .compile()

      app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
      await app.register(cookie, { secret: 'salary-month-gap-integration-cookie-secret' })
      app.setGlobalPrefix('api')
      await app.init()
      await app.getHttpAdapter().getInstance().ready()

      jwt = moduleRef.get(JwtService)
      dbSvc = app.get(DatabaseService)
      const db = dbSvc.db

      await cleanup(db)

      // ── Seed users ────────────────────────────────────────────────────────
      await db
        .insert(users)
        .values(
          [
            { ...ADMIN, monthlySalary: null },
            { ...ACCOUNTANT, monthlySalary: null },
            { ...SENIOR, monthlySalary: '5000' }, // configured, but NOT cron-eligible (not HR/ACCOUNTANT/JUNIOR)
            { ...HR_MISSING, monthlySalary: '1500' },
            { ...HR_COVERED, monthlySalary: '1600' },
            { ...HR_UNCONFIGURED, monthlySalary: null },
            { ...JUNIOR_MISSING, monthlySalary: '900' },
            { ...HR_SOFT_DELETED, monthlySalary: '1700' },
            { ...JUNIOR_MULTI_PROJECT, monthlySalary: '900' }, // user default; both projects override it
            { ...HR_AUDIT_PROOF, monthlySalary: '1800' },
          ].map((u) => ({
            id: u.id,
            email: u.email,
            displayName: u.displayName,
            role: u.role,
            seniorSharePercent: u.seniorSharePercent,
            monthlySalary: u.monthlySalary,
            googleId: `test-google-${u.id}`,
          })),
        )
        .onConflictDoNothing()

      // ── Seed projects + active memberships ────────────────────────────────
      await db.insert(projects).values([
        {
          id: PROJ_JUNIOR,
          name: 'Sal Gap Junior Project',
          companyName: 'Sal Gap Co',
          domain: 'AI',
          startDate: new Date('2026-01-01T00:00:00.000Z'),
          seniorId: SENIOR.id,
          rate: 50,
        },
        {
          id: PROJ_JUNIOR_MULTI_A,
          name: 'Sal Gap Junior Multi A',
          companyName: 'Sal Gap Co',
          domain: 'AI',
          startDate: new Date('2026-01-01T00:00:00.000Z'),
          seniorId: SENIOR.id,
          rate: 50,
        },
        {
          id: PROJ_JUNIOR_MULTI_B,
          name: 'Sal Gap Junior Multi B',
          companyName: 'Sal Gap Co',
          domain: 'AI',
          startDate: new Date('2026-01-01T00:00:00.000Z'),
          seniorId: SENIOR.id,
          rate: 50,
        },
      ])
      // security-review MED-2: two DIFFERENT overrides on the two projects —
      // if the report ever counted both memberships, the amounts would be
      // distinguishable (1234 or 5678), not just duplicated 900s.
      await db.insert(projectFinanceSettings).values([
        { projectId: PROJ_JUNIOR_MULTI_A, juniorSalaryOverride: '1234' },
        { projectId: PROJ_JUNIOR_MULTI_B, juniorSalaryOverride: '5678' },
      ])
      await db.insert(projectMembers).values([
        { projectId: PROJ_JUNIOR, userId: JUNIOR_MISSING.id, leftAt: null },
        { projectId: PROJ_JUNIOR_MULTI_A, userId: JUNIOR_MULTI_PROJECT.id, leftAt: null },
        { projectId: PROJ_JUNIOR_MULTI_B, userId: JUNIOR_MULTI_PROJECT.id, leftAt: null },
      ])

      // ── Seed an EXISTING SALARY row for HR_COVERED, target month ─────────
      await db.insert(transactions).values({
        id: TX_HR_COVERED_SALARY,
        type: 'SALARY',
        status: 'PENDING',
        amount: '1600',
        currency: 'USD',
        senderId: null,
        senderLabel: 'CheekyCheeseIT',
        receiverId: HR_COVERED.id,
        salaryMonth: TARGET_MONTH,
        createdBy: ADMIN.id,
      })

      // ── security-review MED-1: a SALARY row for HR_SOFT_DELETED, then
      // soft-deleted — the receiver must still be excluded from `missing`
      // (backfill cannot actually create a replacement; see the unique
      // index's own comment on why it has no `deleted_at` term).
      await db.insert(transactions).values({
        id: TX_HR_SOFT_DELETED_SALARY,
        type: 'SALARY',
        status: 'PENDING',
        amount: '1700',
        currency: 'USD',
        senderId: null,
        senderLabel: 'CheekyCheeseIT',
        receiverId: HR_SOFT_DELETED.id,
        salaryMonth: TARGET_MONTH,
        createdBy: ADMIN.id,
      })
      await db
        .update(transactions)
        .set({ deletedAt: new Date() })
        .where(eq(transactions.id, TX_HR_SOFT_DELETED_SALARY))
    }, 30_000)

    afterAll(async () => {
      try {
        await cleanup(dbSvc.db)
      } catch {
        // non-fatal
      }
      await app.close()
    }, 15_000)

    function tokenFor(user: SessionUser): string {
      return jwt.sign(user)
    }

    // ── RBAC: report (ADMIN + ACCOUNTANT) ───────────────────────────────────
    const forbiddenForReport: Array<[string, SessionUser]> = [
      ['SENIOR', SENIOR],
      ['HR', HR_MISSING],
      ['JUNIOR', JUNIOR_MISSING],
    ]
    for (const [label, persona] of forbiddenForReport) {
      it(`RBAC report: ${label} → 403`, async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/finance/salary-month-gap?month=${TARGET_MONTH}`,
          cookies: { jwt: tokenFor(persona) },
        })
        expect(res.statusCode).toBe(403)
      })
    }

    it('RBAC report: ADMIN → 200', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/finance/salary-month-gap?month=${TARGET_MONTH}`,
        cookies: { jwt: tokenFor(ADMIN) },
      })
      expect(res.statusCode).toBe(200)
    })

    it('RBAC report: ACCOUNTANT → 200', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/finance/salary-month-gap?month=${TARGET_MONTH}`,
        cookies: { jwt: tokenFor(ACCOUNTANT) },
      })
      expect(res.statusCode).toBe(200)
    })

    // ── RBAC: backfill (ADMIN only — narrower than the report) ─────────────
    it('RBAC backfill: ACCOUNTANT → 403 (can see the gap, cannot close it)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/finance/salary-month-backfill',
        cookies: { jwt: tokenFor(ACCOUNTANT) },
        payload: { month: TARGET_MONTH },
      })
      expect(res.statusCode).toBe(403)
    })

    it('RBAC backfill: SENIOR → 403', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/finance/salary-month-backfill',
        cookies: { jwt: tokenFor(SENIOR) },
        payload: { month: TARGET_MONTH },
      })
      expect(res.statusCode).toBe(403)
    })

    // ── AC5 correctness — real DB, real nonDeletedTransactions view ────────
    //
    // NOTE: `crm_qa` is a SHARED scratch database — many other specs seed
    // their own HR/ACCOUNTANT/JUNIOR fixtures that persist across test files.
    // The gap report is deliberately company-wide (never receiver-scoped —
    // that's the whole point of E-5), so asserting the FULL `missing` array
    // equals exactly this spec's 2 personas would be flaky by construction:
    // it would also have to enumerate every OTHER spec's leftover fixtures for
    // this far-future month. Assert CONTAINS/EXCLUDES for this spec's own
    // known personas instead — the correct granularity for a shared-DB
    // company-wide read.
    it('the gap report includes HR_MISSING and JUNIOR_MISSING, and excludes HR_COVERED / HR_UNCONFIGURED / SENIOR / HR_SOFT_DELETED', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/finance/salary-month-gap?month=${TARGET_MONTH}`,
        cookies: { jwt: tokenFor(ADMIN) },
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as {
        month: string
        missing: Array<{
          userId: string
          role: string
          projectId: string | null
          projectName: string | null
          expectedAmount: number
        }>
      }
      expect(body.month).toBe(TARGET_MONTH)
      const missingIds = body.missing.map((m) => m.userId)

      expect(missingIds).toContain(HR_MISSING.id)
      expect(missingIds).toContain(JUNIOR_MISSING.id)
      // Legitimately absent (AC5 negative space): covered, unconfigured, and a
      // configured-but-not-cron-eligible SENIOR must never appear.
      expect(missingIds).not.toContain(HR_COVERED.id)
      expect(missingIds).not.toContain(HR_UNCONFIGURED.id)
      expect(missingIds).not.toContain(SENIOR.id)
      // security-review MED-1: a SOFT-DELETED SALARY row still blocks the
      // unique index — the report must NOT advertise a backfill it cannot
      // actually perform.
      expect(missingIds).not.toContain(HR_SOFT_DELETED.id)

      const juniorEntry = body.missing.find((m) => m.userId === JUNIOR_MISSING.id)
      expect(juniorEntry).toBeDefined()
      expect(juniorEntry?.projectId).toBe(PROJ_JUNIOR)
      expect(juniorEntry?.projectName).toBe('Sal Gap Junior Project')
      expect(juniorEntry?.expectedAmount).toBe(900)

      const hrEntry = body.missing.find((m) => m.userId === HR_MISSING.id)
      expect(hrEntry).toBeDefined()
      expect(hrEntry?.role).toBe('HR')
      expect(hrEntry?.expectedAmount).toBe(1500)
      expect(hrEntry?.projectId).toBeNull()

      // security-review MED-2: JUNIOR_MULTI_PROJECT sits on TWO active
      // projects (overrides 1234 and 5678) — must appear EXACTLY ONCE, not
      // twice, and with ONE of the two amounts (never their sum, 6912).
      const multiEntries = body.missing.filter((m) => m.userId === JUNIOR_MULTI_PROJECT.id)
      expect(multiEntries).toHaveLength(1)
      expect([1234, 5678]).toContain(multiEntries[0]?.expectedAmount)
    })

    // security-review HIGH-2: real end-to-end proof that the DEFAULT (no
    // `?month`) resolves to `previousSalaryMonthKey()` — the exact same
    // resolver the cron itself uses — through the REAL controller → REAL
    // service path, not a unit-level stub.
    it('omitting ?month defaults to previousSalaryMonthKey() — the SAME month the cron last targeted', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/finance/salary-month-gap',
        cookies: { jwt: tokenFor(ADMIN) },
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { month: string }
      expect(body.month).toBe(previousSalaryMonthKey())
    })

    // ── AC4 — backfill closes the gap, idempotently ─────────────────────────
    it('backfill creates the missing SALARY rows and the report goes clean; a second backfill is a no-op (real ON CONFLICT DO NOTHING)', async () => {
      const before = await app.inject({
        method: 'POST',
        url: '/api/finance/salary-month-backfill',
        cookies: { jwt: tokenFor(ADMIN) },
        payload: { month: TARGET_MONTH },
      })
      expect(before.statusCode).toBe(201)
      // `crm_qa` is shared (see the note above) — backfill is company-wide by
      // design (it re-invokes the SAME createMonthlySalaries the cron uses),
      // so assert THIS spec's personas are gone, not that the array is empty.
      const afterFirst = before.json() as { missing: Array<{ userId: string }> }
      const afterFirstIds = afterFirst.missing.map((m) => m.userId)
      expect(afterFirstIds).not.toContain(HR_MISSING.id)
      expect(afterFirstIds).not.toContain(JUNIOR_MISSING.id)

      // Real DB proof: exactly ONE SALARY row per receiver for this month.
      const rows = await dbSvc.db.query.transactions.findMany({
        where: (t, { and: andOp, eq: eqOp }) =>
          andOp(eqOp(t.type, 'SALARY'), eqOp(t.salaryMonth, TARGET_MONTH)),
      })
      const hrMissingRows = rows.filter((r) => r.receiverId === HR_MISSING.id)
      const juniorRows = rows.filter((r) => r.receiverId === JUNIOR_MISSING.id)
      expect(hrMissingRows).toHaveLength(1)
      expect(juniorRows).toHaveLength(1)

      // Second backfill for the SAME month — idempotent, no duplicate row.
      const second = await app.inject({
        method: 'POST',
        url: '/api/finance/salary-month-backfill',
        cookies: { jwt: tokenFor(ADMIN) },
        payload: { month: TARGET_MONTH },
      })
      expect(second.statusCode).toBe(201)
      const rowsAfterSecond = await dbSvc.db.query.transactions.findMany({
        where: (t, { and: andOp, eq: eqOp }) =>
          andOp(eqOp(t.type, 'SALARY'), eqOp(t.salaryMonth, TARGET_MONTH)),
      })
      expect(rowsAfterSecond.filter((r) => r.receiverId === HR_MISSING.id)).toHaveLength(1)
      expect(rowsAfterSecond.filter((r) => r.receiverId === JUNIOR_MISSING.id)).toHaveLength(1)
    })

    // security-review HIGH-1 — real end-to-end proof: the row `createdBy` is
    // the ADMIN who actually clicked Backfill (not an arbitrary admin looked
    // up with no `orderBy`), and the creation is journalled in
    // `transactionAuditLog` — exactly like every other user-facing creation
    // entry point (createSalary etc.), which the unaudited CRON path
    // (createMonthlySalaries called with no actor) deliberately is not.
    it('backfill attributes createdBy to the calling ADMIN and journals a CREATE audit entry', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/finance/salary-month-backfill',
        cookies: { jwt: tokenFor(ADMIN) },
        payload: { month: AUDIT_MONTH },
      })
      expect(res.statusCode).toBe(201)

      const [row] = await dbSvc.db.query.transactions.findMany({
        where: (t, { and: andOp, eq: eqOp }) =>
          andOp(
            eqOp(t.type, 'SALARY'),
            eqOp(t.salaryMonth, AUDIT_MONTH),
            eqOp(t.receiverId, HR_AUDIT_PROOF.id),
          ),
      })
      expect(row).toBeDefined()
      expect(row?.createdBy).toBe(ADMIN.id)
      // numeric('amount', { precision: 18, scale: 6 }) — Postgres pads to 6dp.
      expect(row?.amount).toBe('1800.000000')

      const auditRows = await dbSvc.db
        .select()
        .from(transactionAuditLog)
        .where(
          and(eq(transactionAuditLog.targetId, row!.id), eq(transactionAuditLog.action, 'CREATE')),
        )
      expect(auditRows).toHaveLength(1)
      expect(auditRows[0]?.actorId).toBe(ADMIN.id)
      // metadata.amount is `emp.monthlySalary` verbatim (users.monthlySalary
      // numeric column, NOT the transactions.amount column — different scale).
      expect(auditRows[0]?.metadata).toMatchObject({
        type: 'SALARY',
        amount: '1800.00',
        currency: 'USD',
      })
    })
  },
)

// ── SHIPPING-ROUTE GATE ───────────────────────────────────────────────────────
// Prove the RBAC gate is on the LIVE production controller, not just the test
// sentinel. Pure `Reflector` metadata reads — NO DB dependency — so, unlike
// the suite above, this one is NEVER `skipIf`'d: it must run in the
// unit-only CI job too (code-review LOW — the old blanket
// `describe.skipIf(!hasDatabaseUrl())` was needlessly skipping a check that
// cannot fail for DB reasons in the exact job that most needs it).
describe('salary-month-gap — SHIPPING route carries the RBAC gate (production controller)', () => {
  const reflector = new Reflector()

  it('getSalaryMonthGap handler ships @Roles(ADMIN, ACCOUNTANT)', () => {
    const roles = reflector.get<string[]>(
      ROLES_KEY,
      FinanceSummaryController.prototype.getSalaryMonthGap,
    )
    expect(roles).toEqual(['ADMIN', 'ACCOUNTANT'])
  })

  it('backfillSalaryMonth handler ships @Roles(ADMIN) — narrower than the report', () => {
    const roles = reflector.get<string[]>(
      ROLES_KEY,
      FinanceSummaryController.prototype.backfillSalaryMonth,
    )
    expect(roles).toEqual(['ADMIN'])
  })

  it('FinanceSummaryController is guarded by @UseGuards(RolesGuard) at class level', () => {
    const guards = Reflect.getMetadata('__guards__', FinanceSummaryController) as
      | unknown[]
      | undefined
    expect(guards).toBeDefined()
    expect(guards).toContain(RolesGuard)
  })
})
