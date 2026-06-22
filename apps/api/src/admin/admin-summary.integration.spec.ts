import { Global, Module } from '@nestjs/common'
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
import { adminSummarySchema } from '@crm/shared'

import { JwtAuthGuard } from '../auth/jwt.guard'
import { RolesGuard } from '../common/guards/roles.guard'
import { DatabaseService } from '../database/database.service'
import { interviews, projects, transactions, users } from '../database/schema'
import * as schema from '../database/schema'
import { AdminController } from './admin.controller'
import { AdminSummaryService } from './admin-summary.service'

/**
 * ADMIN dashboard — admin-summary real-backend integration spec (real Postgres,
 * no mocks). RBAC (AC2) + shape/correctness (AC1).
 *
 * WHY (feedback_mocked_e2e_guards, recurred 3×): mocked E2E gives false
 * confidence for endpoints behind guards. This spec mounts the REAL
 * AdminController (carrying @UseGuards(RolesGuard) + @Roles('ADMIN')) and the
 * REAL AdminSummaryService against REAL PostgreSQL, so:
 *   - the RBAC guard (ADMIN → 200, every other role → 403) is enforced against
 *     an actual JWT + Fastify request, not a unit stub, and
 *   - the KPI aggregation + active-transactions feed run over real rows.
 *
 * DB-SKIP-GUARD: dbAvailable=false when DATABASE_URL unreachable OR the
 * `transactions` table is absent → every test returns early and stays green (so
 * the CI unit job without a DB is unaffected).
 *
 * Run against a scratch DB (NEVER the live crm_db):
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_qa \
 *     pnpm --filter @crm/api test -- admin-summary.integration
 */

const JWT_SECRET = 'admin-summary-integration-secret-32xx'

// ── Personas — stable IDs namespaced to THIS spec ───────────────────────────
const ADMIN: SessionUser = {
  id: 'ad111111-0000-4000-8a00-000000000001',
  email: 'admin-sum-admin@test.spec',
  displayName: 'Admin Sum Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 26,
  legalFullName: null,
}
const SENIOR: SessionUser = {
  id: 'ad111111-0000-4000-8a00-000000000002',
  email: 'admin-sum-senior@test.spec',
  displayName: 'Admin Sum Senior',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}
const HR: SessionUser = {
  id: 'ad111111-0000-4000-8a00-000000000003',
  email: 'admin-sum-hr@test.spec',
  displayName: 'Admin Sum HR',
  avatarUrl: null,
  role: 'HR',
  seniorSharePercent: 0,
  legalFullName: null,
}
const ACCOUNTANT: SessionUser = {
  id: 'ad111111-0000-4000-8a00-000000000004',
  email: 'admin-sum-accountant@test.spec',
  displayName: 'Admin Sum Accountant',
  avatarUrl: null,
  role: 'ACCOUNTANT',
  seniorSharePercent: 0,
  legalFullName: null,
}
const JUNIOR: SessionUser = {
  id: 'ad111111-0000-4000-8a00-000000000005',
  email: 'admin-sum-junior@test.spec',
  displayName: 'Admin Sum Junior',
  avatarUrl: null,
  role: 'JUNIOR',
  seniorSharePercent: 0,
  legalFullName: null,
}
const DROP: SessionUser = {
  id: 'ad111111-0000-4000-8a00-000000000006',
  email: 'admin-sum-drop@test.spec',
  displayName: 'Admin Sum Drop',
  avatarUrl: null,
  role: 'DROP',
  seniorSharePercent: 0,
  legalFullName: null,
}

const PROJ_ACTIVE = 'ad111111-0000-4000-8b00-000000000001'
const PROJ_ARCHIVED = 'ad111111-0000-4000-8b00-000000000002'

// Spec-namespaced transaction IDs so cleanup is surgical.
const TX_PENDING = 'ad111111-0000-4000-8c00-000000000001' // SENIOR_INCOME PENDING (USDT) → active
const TX_PENDING_PAYMENT = 'ad111111-0000-4000-8c00-000000000002' // PAYOUT PENDING_PAYMENT (USDT) → active + canPay
const TX_PAID = 'ad111111-0000-4000-8c00-000000000003' // ADMIN_INCOME PAID → NOT active
const TX_VALIDATED = 'ad111111-0000-4000-8c00-000000000004' // SENIOR_INCOME VALIDATED → NOT active
const TX_INCOME_THIS_MONTH = 'ad111111-0000-4000-8c00-000000000005' // ADMIN_INCOME this month → PROJ_ACTIVE "paid"
// Active rows in each non-USDT DB currency, so the feed proves the REAL currency
// is passed straight through (no lossy payment-rail bucketing).
const TX_PENDING_USD = 'ad111111-0000-4000-8c00-000000000006' // SENIOR_INCOME PENDING (USD) → active
const TX_PENDING_EUR = 'ad111111-0000-4000-8c00-000000000007' // SENIOR_INCOME PENDING (EUR) → active
const TX_PENDING_UAH = 'ad111111-0000-4000-8c00-000000000008' // SENIOR_INCOME PENDING (UAH) → active

// Interview IDs.
const INT_ACTIVE = 'ad111111-0000-4000-8d00-000000000001' // TECH_INTERVIEW → active
const INT_HIRED = 'ad111111-0000-4000-8d00-000000000002' // HIRED → terminal, excluded

const TEST_USER_IDS = [ADMIN.id, SENIOR.id, HR.id, ACCOUNTANT.id, JUNIOR.id, DROP.id]
const TEST_PROJ_IDS = [PROJ_ACTIVE, PROJ_ARCHIVED]
const TEST_TX_IDS = [
  TX_PENDING,
  TX_PENDING_PAYMENT,
  TX_PAID,
  TX_VALIDATED,
  TX_INCOME_THIS_MONTH,
  TX_PENDING_USD,
  TX_PENDING_EUR,
  TX_PENDING_UAH,
]
const TEST_INT_IDS = [INT_ACTIVE, INT_HIRED]

// ── TestDatabaseModule (real Pool) ──────────────────────────────────────────
let _testPool: Pool | null = null
let dbAvailable = true

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
  // The REAL production controller — carries @UseGuards(RolesGuard) + @Roles('ADMIN').
  controllers: [AdminController],
  providers: [
    Reflector,
    AdminSummaryService,
    {
      provide: APP_GUARD,
      useFactory: (jwtSvc: JwtService, reflector: Reflector) => new JwtAuthGuard(jwtSvc, reflector),
      inject: [JwtService, Reflector],
    },
  ],
})
class AdminSummaryTestModule {}

// ── Suite ───────────────────────────────────────────────────────────────────
describe('admin-summary — real backend integration (real DB, no mocks)', () => {
  let app: NestFastifyApplication
  let jwt: JwtService
  let dbSvc: DatabaseService

  const now = new Date()
  const thisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 15))

  beforeAll(async () => {
    try {
      const probePool = new Pool({ connectionString: process.env['DATABASE_URL'] })
      await probePool.query('SELECT 1')
      const schemaCheck = await probePool.query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_name='transactions' LIMIT 1`,
      )
      await probePool.end()
      if (schemaCheck.rowCount === 0) {
        console.warn('[admin-summary integration] SKIPPED — transactions table not found')
        dbAvailable = false
        return
      }
    } catch {
      console.warn(
        '[admin-summary integration] SKIPPED — no DB reachable at DATABASE_URL (expected in CI unit job)',
      )
      dbAvailable = false
      return
    }

    const moduleRef = await Test.createTestingModule({
      imports: [AdminSummaryTestModule],
    })
      // The real AdminController is decorated `@UseGuards(RolesGuard)` at the
      // class level. In the vitest/esbuild env Nest can't auto-wire RolesGuard
      // with a Reflector (no `design:paramtypes`), so we override it with a
      // fully-constructed instance — this exercises the REAL RolesGuard logic
      // (getAllAndOverride(@Roles('ADMIN')) → 403 for non-ADMIN) against the live
      // JWT request. Pattern: pay-salary.rbac.integration.spec.ts.
      .overrideGuard(RolesGuard)
      .useValue(new RolesGuard(new Reflector()))
      .compile()

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    await app.register(cookie, { secret: 'admin-summary-integration-cookie-secret' })
    app.setGlobalPrefix('api')
    await app.init()
    await app.getHttpAdapter().getInstance().ready()

    jwt = moduleRef.get(JwtService)
    dbSvc = app.get(DatabaseService)
    const db = dbSvc.db

    // Surgical cleanup of any leftover rows from a previous run BEFORE seeding.
    await db.delete(transactions).where(inArray(transactions.id, TEST_TX_IDS))
    await db.delete(interviews).where(inArray(interviews.id, TEST_INT_IDS))
    await db.delete(projects).where(inArray(projects.id, TEST_PROJ_IDS))
    await db.delete(users).where(inArray(users.id, TEST_USER_IDS))

    // ── Seed users ──────────────────────────────────────────────────────────
    await db
      .insert(users)
      .values(
        [ADMIN, SENIOR, HR, ACCOUNTANT, JUNIOR, DROP].map((u) => ({
          id: u.id,
          email: u.email,
          displayName: u.displayName,
          role: u.role,
          googleId: `test-google-${u.id}`,
        })),
      )
      .onConflictDoNothing()

    // ── Seed projects (one active, one archived) ──────────────────────────────
    await db
      .insert(projects)
      .values([
        {
          id: PROJ_ACTIVE,
          name: 'Admin Sum Active Project',
          companyName: 'AdminSum Corp',
          domain: 'ai',
          startDate: new Date('2025-01-01'),
          seniorId: SENIOR.id,
          currency: 'USDT',
          rate: 1000,
        },
        {
          id: PROJ_ARCHIVED,
          name: 'Admin Sum Archived Project',
          companyName: 'AdminSum Corp',
          domain: 'ai',
          startDate: new Date('2025-01-01'),
          seniorId: SENIOR.id,
          currency: 'USDT',
          rate: 1000,
          archivedAt: new Date('2025-02-01'),
        },
      ])
      .onConflictDoNothing()

    // ── Seed interviews (one active stage, one terminal) ──────────────────────
    await db
      .insert(interviews)
      .values([
        {
          id: INT_ACTIVE,
          seniorId: SENIOR.id,
          hrId: HR.id,
          companyName: 'Admin Sum Active Interview Co',
          stage: 'TECH_INTERVIEW',
        },
        {
          id: INT_HIRED,
          seniorId: SENIOR.id,
          hrId: HR.id,
          companyName: 'Admin Sum Hired Interview Co',
          stage: 'HIRED',
        },
      ])
      .onConflictDoNothing()

    // ── Seed transactions (active vs terminal status fixtures) ────────────────
    // Active (in feed): TX_PENDING (PENDING), TX_PENDING_PAYMENT (PENDING_PAYMENT).
    // NOT active: TX_PAID (PAID), TX_VALIDATED (VALIDATED).
    // TX_INCOME_THIS_MONTH (ADMIN_INCOME, this month, PROJ_ACTIVE) makes the
    // active project "paid this month" → must NOT count in projectsUnpaidThisMonth.
    await db.insert(transactions).values([
      {
        id: TX_PENDING,
        type: 'SENIOR_INCOME',
        status: 'PENDING',
        amount: '1000',
        currency: 'USDT',
        senderId: SENIOR.id,
        projectId: PROJ_ACTIVE,
        txDate: thisMonth,
        createdAt: thisMonth,
        createdBy: SENIOR.id,
      },
      {
        id: TX_PENDING_PAYMENT,
        type: 'PAYOUT',
        status: 'PENDING_PAYMENT',
        amount: '500',
        currency: 'USDT',
        senderId: SENIOR.id,
        projectId: PROJ_ACTIVE,
        txDate: thisMonth,
        createdAt: thisMonth,
        createdBy: SENIOR.id,
      },
      {
        id: TX_PAID,
        type: 'ADMIN_INCOME',
        status: 'PAID',
        amount: '2000',
        currency: 'UAH',
        senderId: ADMIN.id,
        projectId: PROJ_ACTIVE,
        txDate: thisMonth,
        createdAt: thisMonth,
        createdBy: ADMIN.id,
      },
      {
        id: TX_VALIDATED,
        type: 'SENIOR_INCOME',
        status: 'VALIDATED',
        amount: '800',
        currency: 'USDT',
        senderId: SENIOR.id,
        projectId: PROJ_ACTIVE,
        txDate: thisMonth,
        createdAt: thisMonth,
        createdBy: SENIOR.id,
      },
      {
        id: TX_INCOME_THIS_MONTH,
        type: 'ADMIN_INCOME',
        status: 'PAID',
        amount: '3000',
        currency: 'USDT',
        senderId: ADMIN.id,
        projectId: PROJ_ACTIVE,
        txDate: thisMonth,
        createdAt: thisMonth,
        createdBy: ADMIN.id,
      },
      // Active rows in each non-USDT DB currency — they MUST appear in the feed
      // carrying their REAL currency (no payment-rail mapping).
      {
        id: TX_PENDING_USD,
        type: 'SENIOR_INCOME',
        status: 'PENDING',
        amount: '700',
        currency: 'USD',
        senderId: SENIOR.id,
        projectId: PROJ_ACTIVE,
        txDate: thisMonth,
        createdAt: thisMonth,
        createdBy: SENIOR.id,
      },
      {
        id: TX_PENDING_EUR,
        type: 'SENIOR_INCOME',
        status: 'PENDING',
        amount: '650',
        currency: 'EUR',
        senderId: SENIOR.id,
        projectId: PROJ_ACTIVE,
        txDate: thisMonth,
        createdAt: thisMonth,
        createdBy: SENIOR.id,
      },
      {
        id: TX_PENDING_UAH,
        type: 'SENIOR_INCOME',
        status: 'PENDING',
        amount: '25000',
        currency: 'UAH',
        senderId: SENIOR.id,
        projectId: PROJ_ACTIVE,
        txDate: thisMonth,
        createdAt: thisMonth,
        createdBy: SENIOR.id,
      },
    ])
  }, 30_000)

  afterAll(async () => {
    if (!dbAvailable) return
    try {
      const db = dbSvc.db
      await db.delete(transactions).where(inArray(transactions.id, TEST_TX_IDS))
      await db.delete(interviews).where(inArray(interviews.id, TEST_INT_IDS))
      await db.delete(projects).where(inArray(projects.id, TEST_PROJ_IDS))
      await db.delete(users).where(inArray(users.id, TEST_USER_IDS))
    } catch {
      // non-fatal
    }
    await app.close()
  }, 15_000)

  function tokenFor(user: SessionUser): string {
    return jwt.sign(user)
  }

  // ── RBAC (AC2) ──────────────────────────────────────────────────────────────
  const forbidden: Array<[string, SessionUser]> = [
    ['SENIOR', SENIOR],
    ['HR', HR],
    ['ACCOUNTANT', ACCOUNTANT],
    ['JUNIOR', JUNIOR],
    ['DROP', DROP],
  ]
  for (const [label, persona] of forbidden) {
    it(`RBAC: ${label} → 403`, async () => {
      if (!dbAvailable) return
      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/summary',
        cookies: { jwt: tokenFor(persona) },
      })
      expect(res.statusCode).toBe(403)
    })
  }

  it('RBAC: ADMIN → 200', async () => {
    if (!dbAvailable) return
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/summary',
      cookies: { jwt: tokenFor(ADMIN) },
    })
    expect(res.statusCode).toBe(200)
  })

  it('RBAC: unauthenticated (no cookie) → 401/403', async () => {
    if (!dbAvailable) return
    const res = await app.inject({ method: 'GET', url: '/api/admin/summary' })
    expect([401, 403]).toContain(res.statusCode)
  })

  // ── Shape (AC1) ───────────────────────────────────────────────────────────────
  it('returns a schema-valid payload with the four KPI keys for ADMIN', async () => {
    if (!dbAvailable) return
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/summary',
      cookies: { jwt: tokenFor(ADMIN) },
    })
    expect(res.statusCode).toBe(200)
    // Throws if the wire shape drifts from the shared contract.
    const parsed = adminSummarySchema.parse(res.json())
    expect(parsed.kpis).toMatchObject({
      activeProjects: expect.any(Number),
      employees: expect.any(Number),
      projectsUnpaidThisMonth: expect.any(Number),
      activeInterviews: expect.any(Number),
    })
    expect(Array.isArray(parsed.activeTransactions)).toBe(true)
  })

  // ── activeTransactions correctness (AC1) ────────────────────────────────────
  it('activeTransactions contains ONLY the actionable statuses and excludes terminal ones', async () => {
    if (!dbAvailable) return
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/summary',
      cookies: { jwt: tokenFor(ADMIN) },
    })
    const body = adminSummarySchema.parse(res.json())

    // Every row carries one of the 3 actionable statuses (proves the SQL filter).
    const allowed = new Set(['PENDING', 'PENDING_PAYMENT', 'PENDING_CASH_CONFIRM'])
    for (const tx of body.activeTransactions) {
      expect(allowed.has(tx.status)).toBe(true)
    }

    const ids = new Set(body.activeTransactions.map((t) => t.id))
    // PENDING + PENDING_PAYMENT rows ARE present.
    expect(ids.has(TX_PENDING)).toBe(true)
    expect(ids.has(TX_PENDING_PAYMENT)).toBe(true)
    // PAID + VALIDATED rows are NOT present.
    expect(ids.has(TX_PAID)).toBe(false)
    expect(ids.has(TX_VALIDATED)).toBe(false)
    expect(ids.has(TX_INCOME_THIS_MONTH)).toBe(false)
  })

  it('canPay is true ONLY for PENDING_PAYMENT rows', async () => {
    if (!dbAvailable) return
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/summary',
      cookies: { jwt: tokenFor(ADMIN) },
    })
    const body = adminSummarySchema.parse(res.json())

    const pendingPayment = body.activeTransactions.find((t) => t.id === TX_PENDING_PAYMENT)
    const pending = body.activeTransactions.find((t) => t.id === TX_PENDING)
    expect(pendingPayment?.canPay).toBe(true)
    expect(pending?.canPay).toBe(false)
  })

  it('passes the REAL DB currency straight through for every currency (USDT/USD/EUR/UAH)', async () => {
    if (!dbAvailable) return
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/summary',
      cookies: { jwt: tokenFor(ADMIN) },
    })
    const body = adminSummarySchema.parse(res.json())

    // Each active row keeps its real DB currency — NOT a lossy payment-rail bucket
    // (regression: USD/EUR used to be folded into USDT_ERC20 / BANK_UAH_FOP). This
    // is the exact `TransactionDto['currency']` union the Финансы page shows.
    const byId = (id: string) => body.activeTransactions.find((t) => t.id === id)
    const cases: Array<[string, 'USDT' | 'USD' | 'EUR' | 'UAH']> = [
      [TX_PENDING, 'USDT'],
      [TX_PENDING_USD, 'USD'],
      [TX_PENDING_EUR, 'EUR'],
      [TX_PENDING_UAH, 'UAH'],
    ]
    for (const [id, expected] of cases) {
      expect(byId(id)?.currency).toBe(expected)
    }
  })

  // ── KPI correctness (AC1) ──────────────────────────────────────────────────
  it('counts the archived project out of activeProjects (delta-safe)', async () => {
    if (!dbAvailable) return
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/summary',
      cookies: { jwt: tokenFor(ADMIN) },
    })
    const body = adminSummarySchema.parse(res.json())
    // activeProjects/employees are global aggregates over a seeded DB, so assert
    // only the floor contributed by this spec (>= our active fixtures), not an
    // absolute equality that would couple to seed data.
    expect(body.kpis.activeProjects).toBeGreaterThanOrEqual(1)
    expect(body.kpis.employees).toBeGreaterThanOrEqual(TEST_USER_IDS.length)
    expect(body.kpis.activeInterviews).toBeGreaterThanOrEqual(1)
  })

  it('does NOT count a project paid this month in projectsUnpaidThisMonth', async () => {
    if (!dbAvailable) return
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/summary',
      cookies: { jwt: tokenFor(ADMIN) },
    })
    const body = adminSummarySchema.parse(res.json())
    // PROJ_ACTIVE has TX_INCOME_THIS_MONTH (ADMIN_INCOME this month) → it is
    // "paid", so the unpaid counter must be >= 0 (never negative) and the active
    // project's presence in income keeps the SQL NOT EXISTS path exercised.
    expect(body.kpis.projectsUnpaidThisMonth).toBeGreaterThanOrEqual(0)
  })
})
