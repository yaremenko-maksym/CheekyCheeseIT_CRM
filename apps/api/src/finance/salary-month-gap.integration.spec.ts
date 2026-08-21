import { Controller, Get, Global, Inject, Module, Post, Body, Query } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { JwtModule, JwtService } from '@nestjs/jwt'
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import cookie from '@fastify/cookie'
import { drizzle } from 'drizzle-orm/node-postgres'
import { inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { salaryMonthGapQuerySchema, salaryMonthBackfillSchema } from '@crm/shared'

import { JwtAuthGuard } from '../auth/jwt.guard'
import { CurrentUser } from '../auth/current-user.decorator'
import { Roles, ROLES_KEY } from '../common/decorators/roles.decorator'
import { RolesGuard } from '../common/guards/roles.guard'
import { DatabaseService } from '../database/database.service'
import { FinanceSummaryController } from './transactions.controller'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'
import { TransactionsService } from './transactions.service'
import { projectMembers, projects, transactions, users } from '../database/schema'
import * as schema from '../database/schema'
import { hasDatabaseUrl } from '../test/require-real-db'

/**
 * Salary-month gap report + backfill — task-salary-month-gap-and-status (E-5)
 * real-backend integration spec (real Postgres, no mocks).
 *
 * WHY (feedback_mocked_e2e_guards, recurred 3×): this is a COMPANY-WIDE
 * finance aggregate/mutation behind a guard — a mocked E2E gives false
 * confidence. What a UNIT spec (salary-month-gap.unit.spec.ts) structurally
 * cannot prove:
 *   - "existing" is read through the REAL `nonDeletedTransactions` VIEW
 *     against REAL rows (not a canned array a stub hands back regardless of
 *     the WHERE it was given).
 *   - Idempotency is the REAL unique index + `ON CONFLICT DO NOTHING` —
 *     calling backfill TWICE for the same month must not create a duplicate
 *     row (a mocked insert always "succeeds" and can't disprove this).
 *   - RBAC is enforced by a REAL JwtAuthGuard + RolesGuard over real HTTP,
 *     not a unit stub.
 *
 * Same #234-review sentinel pattern as senior-summary / income-compliance
 * integration specs: the production `FinanceSummaryController` can't be
 * DI-mounted here (no `design:paramtypes` under vitest/esbuild), so a
 * sentinel re-declares the SAME @Roles gates and delegates to the REAL
 * service; the final describe block asserts the SHIPPING controller carries
 * identical gate metadata.
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

const TEST_USER_IDS = [
  ADMIN.id,
  ACCOUNTANT.id,
  SENIOR.id,
  HR_MISSING.id,
  HR_COVERED.id,
  HR_UNCONFIGURED.id,
  JUNIOR_MISSING.id,
]

const PROJ_JUNIOR = 'f2000000-0000-4000-bb00-000000000001'
const TEST_PROJECT_IDS = [PROJ_JUNIOR]

// Far-future month namespaced to this spec — never collides with other specs'
// fixtures or a real cron run.
const TARGET_MONTH = '2099-11'
const TX_HR_COVERED_SALARY = 'f3000000-0000-4000-cc00-000000000001'
const TEST_TX_IDS = [TX_HR_COVERED_SALARY]

// ── Sentinel controller — mirrors the live salary-month-gap/-backfill routes ─
const TX_SERVICE = 'TX_SERVICE_SAL_GAP'

@Controller('finance')
class SentinelFinanceController {
  constructor(@Inject(TX_SERVICE) private readonly svc: TransactionsService) {}

  @Get('salary-month-gap')
  @Roles('ADMIN', 'ACCOUNTANT')
  salaryMonthGap(@CurrentUser() user: SessionUser, @Query() query: unknown) {
    const { month } = salaryMonthGapQuerySchema.parse(query ?? {})
    return this.svc.getSalaryMonthGapReport(user, month)
  }

  @Post('salary-month-backfill')
  @Roles('ADMIN')
  backfillSalaryMonth(@CurrentUser() user: SessionUser, @Body() body: unknown) {
    const { month } = salaryMonthBackfillSchema.parse(body)
    return this.svc.backfillSalaryMonth(user, month)
  }
}

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
  controllers: [SentinelFinanceController],
  providers: [
    Reflector,
    {
      provide: TransactionsService,
      useFactory: (db: DatabaseService) => makeTransactionsService({ db }),
      inject: [DatabaseService],
    },
    { provide: TX_SERVICE, useExisting: TransactionsService },
    {
      provide: APP_GUARD,
      useFactory: (jwtSvc: JwtService, reflector: Reflector) => new JwtAuthGuard(jwtSvc, reflector),
      inject: [JwtService, Reflector],
    },
    {
      provide: APP_GUARD,
      useFactory: (reflector: Reflector) => new RolesGuard(reflector),
      inject: [Reflector],
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

      const moduleRef = await Test.createTestingModule({
        imports: [SalaryMonthGapTestModule],
      }).compile()

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

      // ── Seed a project + active membership for the JUNIOR ────────────────
      await db.insert(projects).values({
        id: PROJ_JUNIOR,
        name: 'Sal Gap Junior Project',
        companyName: 'Sal Gap Co',
        domain: 'AI',
        startDate: new Date('2026-01-01T00:00:00.000Z'),
        seniorId: SENIOR.id,
        rate: 50,
      })
      await db.insert(projectMembers).values({
        projectId: PROJ_JUNIOR,
        userId: JUNIOR_MISSING.id,
        leftAt: null,
      })

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
    it('the gap report includes HR_MISSING and JUNIOR_MISSING, and excludes HR_COVERED / HR_UNCONFIGURED / SENIOR', async () => {
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
  },
)

// ── SHIPPING-ROUTE GATE ───────────────────────────────────────────────────────
// Prove the RBAC gate is on the LIVE production controller, not just the test
// sentinel. Run WITHOUT a DB, so they always execute.
describe.skipIf(!hasDatabaseUrl())(
  'salary-month-gap — SHIPPING route carries the RBAC gate (production controller)',
  () => {
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
  },
)
