import { Controller, Get, Global, Inject, Module } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { JwtModule, JwtService } from '@nestjs/jwt'
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import cookie from '@fastify/cookie'
import { drizzle } from 'drizzle-orm/node-postgres'
import { inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SessionUser, SeniorSummaryDto as SeniorSummaryDtoT } from '@crm/shared'
import { seniorSummarySchema } from '@crm/shared'

import { JwtAuthGuard } from '../auth/jwt.guard'
import { CurrentUser } from '../auth/current-user.decorator'
import { Roles } from '../common/decorators/roles.decorator'
import { RolesGuard } from '../common/guards/roles.guard'
import { DatabaseService } from '../database/database.service'
import { TransactionsService } from './transactions.service'
import { payoutRequests, projects, transactions, users } from '../database/schema'
import * as schema from '../database/schema'

/**
 * SENIOR dashboard — senior-summary real-backend integration spec (real
 * Postgres, no mocks). AC1 (real data) + AC2 (RBAC + STRICT self-scoping).
 *
 * WHY (feedback_mocked_e2e_guards, recurred 3×): mocked E2E gives false
 * confidence for endpoints behind guards — especially a finance endpoint where
 * a scoping bug leaks ANOTHER senior's income. This spec exercises the REAL
 * TransactionsService.getSeniorSummary through a Fastify request with a real
 * JwtAuthGuard + RolesGuard against REAL PostgreSQL so:
 *   - the RBAC gate (SENIOR/ADMIN → 200, everyone else → 403) is enforced
 *     against an actual JWT request, not a unit stub, and
 *   - the self-scoping is PROVEN: SENIOR_A's summary contains ONLY A's
 *     projects/income/payouts and NEVER B's (the central security claim).
 *
 * DB-SKIP-GUARD: dbAvailable=false when DATABASE_URL unreachable OR the
 * `projects` table is absent → every test returns early and stays green (so the
 * CI unit job without a DB is unaffected).
 *
 * Run against the scratch crm_qa DB (NEVER the live crm_db — guard #233 also
 * blocks crm_db locally). vitest auto-loads apps/api/.env.test (→ crm_qa) for
 * `*.integration.spec.ts` runs:
 *   pnpm --filter @crm/api test -- senior-summary.integration
 */

const JWT_SECRET = 'senior-summary-integration-secret-32-chars'

// ── Personas — stable IDs namespaced to THIS spec ───────────────────────────
const ADMIN: SessionUser = {
  id: 'c0000000-0000-4000-aa00-000000000001',
  email: 'sr-sum-admin@test.spec',
  displayName: 'SR Sum Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 26,
  legalFullName: null,
}
// SENIOR_A — owns 2 active projects, has PAID income + PENDING payout + salary.
const SENIOR_A: SessionUser = {
  id: 'c0000000-0000-4000-aa00-000000000002',
  email: 'sr-sum-a@test.spec',
  displayName: 'SR Sum A',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 30,
  legalFullName: null,
}
// SENIOR_B — owns a DIFFERENT project with DIFFERENT income/payout. Must NEVER
// surface in SENIOR_A's summary (the scoping proof).
const SENIOR_B: SessionUser = {
  id: 'c0000000-0000-4000-aa00-000000000003',
  email: 'sr-sum-b@test.spec',
  displayName: 'SR Sum B',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 50,
  legalFullName: null,
}
const JUNIOR: SessionUser = {
  id: 'c0000000-0000-4000-aa00-000000000004',
  email: 'sr-sum-junior@test.spec',
  displayName: 'SR Sum Junior',
  avatarUrl: null,
  role: 'JUNIOR',
  seniorSharePercent: 0,
  legalFullName: null,
}
const HR: SessionUser = {
  id: 'c0000000-0000-4000-aa00-000000000005',
  email: 'sr-sum-hr@test.spec',
  displayName: 'SR Sum HR',
  avatarUrl: null,
  role: 'HR',
  seniorSharePercent: 0,
  legalFullName: null,
}
const ACCOUNTANT: SessionUser = {
  id: 'c0000000-0000-4000-aa00-000000000006',
  email: 'sr-sum-accountant@test.spec',
  displayName: 'SR Sum Accountant',
  avatarUrl: null,
  role: 'ACCOUNTANT',
  seniorSharePercent: 0,
  legalFullName: null,
}
const DROP: SessionUser = {
  id: 'c0000000-0000-4000-aa00-000000000007',
  email: 'sr-sum-drop@test.spec',
  displayName: 'SR Sum Drop',
  avatarUrl: null,
  role: 'DROP',
  seniorSharePercent: 0,
  legalFullName: null,
}

// ── Spec-namespaced project IDs ──────────────────────────────────────────────
const PROJ_A1 = 'c0000000-0000-4000-bb00-000000000001' // SENIOR_A active, override 40%
const PROJ_A2 = 'c0000000-0000-4000-bb00-000000000002' // SENIOR_A active, no override → 30% default
const PROJ_A_ARCHIVED = 'c0000000-0000-4000-bb00-000000000003' // SENIOR_A archived → excluded
const PROJ_B1 = 'c0000000-0000-4000-bb00-000000000004' // SENIOR_B active → must NOT leak to A

// ── Spec-namespaced transaction IDs ──────────────────────────────────────────
const TX_A_INCOME_PAID_1 = 'c0000000-0000-4000-cc00-000000000001' // A: PAID SENIOR_INCOME 1000 @40% = 400
const TX_A_INCOME_PAID_2 = 'c0000000-0000-4000-cc00-000000000002' // A: PAID SENIOR_INCOME 500 @30% = 150
const TX_A_INCOME_PENDING = 'c0000000-0000-4000-cc00-000000000003' // A: PENDING SENIOR_INCOME → excluded
const TX_B_INCOME_PAID = 'c0000000-0000-4000-cc00-000000000004' // B: PAID SENIOR_INCOME 9999 → must NOT count for A
const TX_A_SALARY = 'c0000000-0000-4000-cc00-000000000005' // A: current-month SALARY 1200 PENDING

// ── Spec-namespaced payout_request IDs ───────────────────────────────────────
const PR_A_PENDING_1 = 'c0000000-0000-4000-dd00-000000000001' // A: PENDING payable 740
const PR_A_PENDING_2 = 'c0000000-0000-4000-dd00-000000000002' // A: PENDING payable 260
const PR_A_PAID = 'c0000000-0000-4000-dd00-000000000003' // A: PAID → excluded
const PR_B_PENDING = 'c0000000-0000-4000-dd00-000000000004' // B: PENDING → must NOT count for A

const TEST_USER_IDS = [ADMIN.id, SENIOR_A.id, SENIOR_B.id, JUNIOR.id, HR.id, ACCOUNTANT.id, DROP.id]
const TEST_PROJECT_IDS = [PROJ_A1, PROJ_A2, PROJ_A_ARCHIVED, PROJ_B1]
const TEST_TX_IDS = [
  TX_A_INCOME_PAID_1,
  TX_A_INCOME_PAID_2,
  TX_A_INCOME_PENDING,
  TX_B_INCOME_PAID,
  TX_A_SALARY,
]
const TEST_PR_IDS = [PR_A_PENDING_1, PR_A_PENDING_2, PR_A_PAID, PR_B_PENDING]

// ── Sentinel controller — mirrors the real /finance/senior-summary route ──────
const TX_SERVICE = 'TX_SERVICE_SR_SUM'

@Controller('finance')
class SentinelFinanceController {
  constructor(@Inject(TX_SERVICE) private readonly svc: TransactionsService) {}

  @Get('senior-summary')
  @Roles('SENIOR', 'ADMIN')
  seniorSummary(@CurrentUser() user: SessionUser) {
    return this.svc.getSeniorSummary(user)
  }
}

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
  controllers: [SentinelFinanceController],
  providers: [
    Reflector,
    // InvoicesService / DocumentsService collaborators are stubbed — getSeniorSummary
    // never touches them (read-only aggregate over projects + transactions + payouts).
    {
      provide: TransactionsService,
      useFactory: (db: DatabaseService) => new TransactionsService(db, {} as never, {} as never),
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
class SeniorSummaryTestModule {}

// ── Suite ───────────────────────────────────────────────────────────────────
describe('senior-summary — real backend integration (real DB, no mocks)', () => {
  let app: NestFastifyApplication
  let jwt: JwtService
  let dbSvc: DatabaseService

  const now = new Date()
  const thisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 15))
  const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15))
  const salaryMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`

  async function cleanup(db: DatabaseService['db']): Promise<void> {
    // Order matters: payout_requests + transactions FK → projects/users.
    await db.delete(payoutRequests).where(inArray(payoutRequests.id, TEST_PR_IDS))
    await db.delete(transactions).where(inArray(transactions.id, TEST_TX_IDS))
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
        console.warn('[senior-summary integration] SKIPPED — projects table not found')
        dbAvailable = false
        return
      }
    } catch {
      console.warn(
        '[senior-summary integration] SKIPPED — no DB reachable at DATABASE_URL (expected in CI unit job)',
      )
      dbAvailable = false
      return
    }

    const moduleRef = await Test.createTestingModule({
      imports: [SeniorSummaryTestModule],
    }).compile()

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    await app.register(cookie, { secret: 'senior-summary-integration-cookie-secret' })
    app.setGlobalPrefix('api')
    await app.init()
    await app.getHttpAdapter().getInstance().ready()

    jwt = moduleRef.get(JwtService)
    dbSvc = app.get(DatabaseService)
    const db = dbSvc.db

    // Surgical cleanup of any leftover rows BEFORE seeding (deterministic counts).
    await cleanup(db)

    // ── Seed users ──────────────────────────────────────────────────────────
    await db
      .insert(users)
      .values(
        [ADMIN, SENIOR_A, SENIOR_B, JUNIOR, HR, ACCOUNTANT, DROP].map((u) => ({
          id: u.id,
          email: u.email,
          displayName: u.displayName,
          role: u.role,
          seniorSharePercent: u.seniorSharePercent,
          googleId: `test-google-${u.id}`,
        })),
      )
      .onConflictDoNothing()

    // ── Seed projects ─────────────────────────────────────────────────────────
    await db.insert(projects).values([
      {
        id: PROJ_A1,
        name: 'A Project One',
        companyName: 'Acme A1',
        domain: 'AI',
        startDate: lastMonth,
        seniorId: SENIOR_A.id,
        rate: 50,
        seniorSharePercentOverride: 40,
        createdAt: lastMonth,
      },
      {
        id: PROJ_A2,
        name: 'A Project Two',
        companyName: 'Globex A2',
        domain: 'EdTech',
        startDate: thisMonth,
        seniorId: SENIOR_A.id,
        rate: 40,
        seniorSharePercentOverride: null,
        createdAt: thisMonth,
      },
      {
        id: PROJ_A_ARCHIVED,
        name: 'A Project Archived',
        companyName: 'Dead A3',
        domain: 'E-Commerce',
        startDate: lastMonth,
        seniorId: SENIOR_A.id,
        rate: 30,
        archivedAt: thisMonth,
        createdAt: lastMonth,
      },
      {
        id: PROJ_B1,
        name: 'B Project One',
        companyName: 'Initech B1',
        domain: 'AI',
        startDate: lastMonth,
        seniorId: SENIOR_B.id,
        rate: 60,
        seniorSharePercentOverride: 50,
        createdAt: lastMonth,
      },
    ])

    // ── Seed income transactions ────────────────────────────────────────────
    await db.insert(transactions).values([
      {
        id: TX_A_INCOME_PAID_1,
        type: 'SENIOR_INCOME',
        status: 'PAID',
        amount: '1000',
        currency: 'USD',
        receiverId: SENIOR_A.id,
        projectId: PROJ_A1,
        seniorSharePercent: 40,
        txDate: thisMonth,
        createdAt: thisMonth,
        createdBy: SENIOR_A.id,
      },
      {
        id: TX_A_INCOME_PAID_2,
        type: 'SENIOR_INCOME',
        status: 'PAID',
        amount: '500',
        currency: 'USD',
        receiverId: SENIOR_A.id,
        projectId: PROJ_A2,
        seniorSharePercent: 30,
        txDate: lastMonth,
        createdAt: lastMonth,
        createdBy: SENIOR_A.id,
      },
      {
        // PENDING → must NOT count toward seniorShareIncome.
        id: TX_A_INCOME_PENDING,
        type: 'SENIOR_INCOME',
        status: 'PENDING',
        amount: '777',
        currency: 'USD',
        receiverId: SENIOR_A.id,
        projectId: PROJ_A1,
        seniorSharePercent: 40,
        txDate: thisMonth,
        createdAt: thisMonth,
        createdBy: SENIOR_A.id,
      },
      {
        // SENIOR_B's PAID income — must NEVER surface in SENIOR_A's summary.
        id: TX_B_INCOME_PAID,
        type: 'SENIOR_INCOME',
        status: 'PAID',
        amount: '9999',
        currency: 'USD',
        receiverId: SENIOR_B.id,
        projectId: PROJ_B1,
        seniorSharePercent: 50,
        txDate: thisMonth,
        createdAt: thisMonth,
        createdBy: SENIOR_B.id,
      },
      {
        id: TX_A_SALARY,
        type: 'SALARY',
        status: 'PENDING',
        amount: '1200',
        currency: 'USD',
        senderId: ADMIN.id,
        senderLabel: 'CheekyCheeseIT',
        receiverId: SENIOR_A.id,
        salaryMonth,
        createdAt: thisMonth,
        createdBy: ADMIN.id,
      },
    ])

    // ── Seed payout_requests ──────────────────────────────────────────────────
    await db.insert(payoutRequests).values([
      {
        id: PR_A_PENDING_1,
        seniorId: SENIOR_A.id,
        incomeAmount: '1000',
        payableAmount: '740',
        contractAddress: '0x' + 'a'.repeat(40),
        status: 'PENDING',
      },
      {
        id: PR_A_PENDING_2,
        seniorId: SENIOR_A.id,
        incomeAmount: '500',
        payableAmount: '260',
        contractAddress: '0x' + 'b'.repeat(40),
        status: 'PENDING',
      },
      {
        // PAID → must NOT count toward pendingPayouts.
        id: PR_A_PAID,
        seniorId: SENIOR_A.id,
        incomeAmount: '300',
        payableAmount: '200',
        contractAddress: '0x' + 'c'.repeat(40),
        status: 'PAID',
      },
      {
        // SENIOR_B's PENDING payout — must NEVER count for SENIOR_A.
        id: PR_B_PENDING,
        seniorId: SENIOR_B.id,
        incomeAmount: '5000',
        payableAmount: '3000',
        contractAddress: '0x' + 'd'.repeat(40),
        status: 'PENDING',
      },
    ])
  }, 30_000)

  afterAll(async () => {
    if (!dbAvailable) return
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

  async function summaryAs(user: SessionUser): Promise<SeniorSummaryDtoT> {
    const res = await app.inject({
      method: 'GET',
      url: '/api/finance/senior-summary',
      cookies: { jwt: tokenFor(user) },
    })
    return seniorSummarySchema.parse(res.json())
  }

  // ── RBAC (AC2) ──────────────────────────────────────────────────────────────
  const forbidden: Array<[string, SessionUser]> = [
    ['JUNIOR', JUNIOR],
    ['HR', HR],
    ['ACCOUNTANT', ACCOUNTANT],
    ['DROP', DROP],
  ]
  for (const [label, persona] of forbidden) {
    it(`RBAC: ${label} → 403`, async () => {
      if (!dbAvailable) return
      const res = await app.inject({
        method: 'GET',
        url: '/api/finance/senior-summary',
        cookies: { jwt: tokenFor(persona) },
      })
      expect(res.statusCode).toBe(403)
    })
  }

  it('RBAC: SENIOR → 200', async () => {
    if (!dbAvailable) return
    const res = await app.inject({
      method: 'GET',
      url: '/api/finance/senior-summary',
      cookies: { jwt: tokenFor(SENIOR_A) },
    })
    expect(res.statusCode).toBe(200)
  })

  it('RBAC: ADMIN → 200', async () => {
    if (!dbAvailable) return
    const res = await app.inject({
      method: 'GET',
      url: '/api/finance/senior-summary',
      cookies: { jwt: tokenFor(ADMIN) },
    })
    expect(res.statusCode).toBe(200)
  })

  // ── KPI shape + correctness (AC1) ─────────────────────────────────────────────
  it('returns a schema-valid KPI payload for SENIOR_A', async () => {
    if (!dbAvailable) return
    const body = await summaryAs(SENIOR_A)
    expect(body).toBeTruthy()
  })

  it('activeProjects: only own ACTIVE projects, with effective share %', async () => {
    if (!dbAvailable) return
    const body = await summaryAs(SENIOR_A)
    // PROJ_A1 + PROJ_A2 active; PROJ_A_ARCHIVED excluded; PROJ_B1 (B's) NOT visible.
    expect(body.activeProjects.count).toBe(2)
    const ids = body.activeProjects.items.map((p) => p.id).sort()
    expect(ids).toEqual([PROJ_A1, PROJ_A2].sort())
    const a1 = body.activeProjects.items.find((p) => p.id === PROJ_A1)!
    const a2 = body.activeProjects.items.find((p) => p.id === PROJ_A2)!
    expect(a1.sharePercent).toBe(40) // project override
    expect(a2.sharePercent).toBe(30) // user default (SENIOR_A.seniorSharePercent)
  })

  it('seniorShareIncome: own PAID SENIOR_INCOME share (total + this month)', async () => {
    if (!dbAvailable) return
    const body = await summaryAs(SENIOR_A)
    // total = 1000*0.40 (this month) + 500*0.30 (last month) = 400 + 150 = 550
    expect(body.seniorShareIncome.total).toBeCloseTo(550, 6)
    // this month = 400 only (PROJ_A2 income was last month; PENDING 777 excluded)
    expect(body.seniorShareIncome.thisMonth).toBeCloseTo(400, 6)
    expect(body.seniorShareIncome.currency).toBe('USD')
  })

  it('pendingPayouts: own PENDING payout_requests only (count + Σ payable)', async () => {
    if (!dbAvailable) return
    const body = await summaryAs(SENIOR_A)
    // PR_A_PENDING_1 (740) + PR_A_PENDING_2 (260) = 1000; PAID excluded; B's excluded.
    expect(body.pendingPayouts.count).toBe(2)
    expect(body.pendingPayouts.amount).toBeCloseTo(1000, 6)
  })

  it('mySalaryStatus: own current-month salary', async () => {
    if (!dbAvailable) return
    const body = await summaryAs(SENIOR_A)
    expect(body.mySalaryStatus).not.toBeNull()
    expect(body.mySalaryStatus!.amount).toBe(1200)
    expect(body.mySalaryStatus!.status).toBe('PENDING')
  })

  // ── SELF-SCOPING — the central security claim (AC2) ──────────────────────────
  it('SCOPING: SENIOR_A NEVER sees SENIOR_B figures', async () => {
    if (!dbAvailable) return
    const a = await summaryAs(SENIOR_A)
    // B's project (PROJ_B1) must not appear in A's active projects.
    const aProjectIds = a.activeProjects.items.map((p) => p.id)
    expect(aProjectIds).not.toContain(PROJ_B1)
    // B's PAID income (9999 @50% = 4999.5) must not bleed into A's totals.
    expect(a.seniorShareIncome.total).toBeCloseTo(550, 6)
    expect(a.seniorShareIncome.total).not.toBeCloseTo(550 + 4999.5, 1)
    // B's PENDING payout (3000) must not bleed into A's pending amount.
    expect(a.pendingPayouts.amount).toBeCloseTo(1000, 6)
  })

  it('SCOPING: SENIOR_B sees ONLY B figures (mirror of A)', async () => {
    if (!dbAvailable) return
    const b = await summaryAs(SENIOR_B)
    // B has exactly 1 active project (PROJ_B1) with override 50%.
    expect(b.activeProjects.count).toBe(1)
    expect(b.activeProjects.items[0]!.id).toBe(PROJ_B1)
    expect(b.activeProjects.items[0]!.sharePercent).toBe(50)
    // B income = 9999 * 0.50 = 4999.5 (this month). A's figures must not appear.
    expect(b.seniorShareIncome.total).toBeCloseTo(4999.5, 6)
    expect(b.seniorShareIncome.total).not.toBeCloseTo(550, 1)
    // B pending payout = 3000.
    expect(b.pendingPayouts.count).toBe(1)
    expect(b.pendingPayouts.amount).toBeCloseTo(3000, 6)
    // B has no salary row → null.
    expect(b.mySalaryStatus).toBeNull()
  })
})
