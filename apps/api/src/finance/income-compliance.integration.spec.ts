import { Controller, Get, Global, Inject, Module, Query } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { JwtModule, JwtService } from '@nestjs/jwt'
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import cookie from '@fastify/cookie'
import { drizzle } from 'drizzle-orm/node-postgres'
import { inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SessionUser, IncomeComplianceOverviewDto } from '@crm/shared'
import { incomeComplianceOverviewSchema, incomeComplianceQuerySchema } from '@crm/shared'

import { JwtAuthGuard } from '../auth/jwt.guard'
import { CurrentUser } from '../auth/current-user.decorator'
import { Roles, ROLES_KEY } from '../common/decorators/roles.decorator'
import { RolesGuard } from '../common/guards/roles.guard'
import { DatabaseService } from '../database/database.service'
import { FinanceSummaryController } from './transactions.controller'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'
import { projects, transactions, users } from '../database/schema'
import * as schema from '../database/schema'

/**
 * Income compliance — «Контроль приходов» real-backend integration spec (real
 * Postgres, no mocks). AC4 (RBAC: ADMIN/ACCOUNTANT → 200, everyone else → 403)
 * + AC1/AC2/AC3 (X/N correctness, VALIDATED|PAID criterion, only active projects).
 *
 * WHY (feedback_mocked_e2e_guards, recurred 3×): this is a COMPANY-WIDE finance
 * aggregate over MANY income receivers behind a guard — a mocked E2E gives false
 * confidence. A scoping/RBAC bug here leaks every senior's/drop's income status
 * to a non-privileged caller. This spec drives the REAL
 * `TransactionsService.getIncomeComplianceOverview` through a Fastify request
 * with a real JwtAuthGuard + RolesGuard against REAL PostgreSQL so the RBAC gate
 * (ADMIN/ACCOUNTANT → 200, everyone else → 403) is enforced against an actual
 * JWT request, not a unit stub.
 *
 * Same #234-review pattern as senior-summary.integration.spec.ts: the production
 * `FinanceSummaryController` uses type-based constructor injection (no
 * `design:paramtypes` under vitest/esbuild), so it can't be DI-mounted here.
 * A sentinel re-declares the SAME @Roles('ADMIN','ACCOUNTANT') gate and delegates
 * to the REAL service, exercising live 403/200 over real HTTP; the FINAL
 * describe block asserts the SHIPPING controller carries the identical gate
 * metadata.
 *
 * DB-SKIP-GUARD: dbAvailable=false when DATABASE_URL unreachable OR the
 * `projects` table is absent → every test returns early and stays green (so the
 * CI unit job without a DB is unaffected).
 *
 * Run against the scratch crm_qa DB (NEVER the live crm_db — guard #233 also
 * blocks crm_db locally). vitest auto-loads apps/api/.env.test (→ crm_qa) for
 * `*.integration.spec.ts` runs:
 *   pnpm --filter @crm/api test -- income-compliance.integration
 */

const JWT_SECRET = 'income-compliance-integration-secret-32-chars'

// ── Personas — stable IDs namespaced to THIS spec ───────────────────────────
const ADMIN: SessionUser = {
  id: 'e1000000-0000-4000-aa00-000000000001',
  email: 'inc-comp-admin@test.spec',
  displayName: 'Inc Comp Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 26,
  legalFullName: null,
}
// ADMIN-as-senior — owns a project via seniorId, income type ADMIN_INCOME.
const ADMIN_OWNER: SessionUser = {
  id: 'e1000000-0000-4000-aa00-000000000002',
  email: 'inc-comp-admin-owner@test.spec',
  displayName: 'Inc Comp Admin Owner',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 26,
  legalFullName: null,
}
// SENIOR_LAG — 2 active projects, only 1 with a counted income → 1/2.
const SENIOR_LAG: SessionUser = {
  id: 'e1000000-0000-4000-aa00-000000000003',
  email: 'inc-comp-senior-lag@test.spec',
  displayName: 'Inc Comp Senior Lag',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 30,
  legalFullName: null,
}
// SENIOR_DONE — 1 active project with a VALIDATED income → 1/1 complete.
const SENIOR_DONE: SessionUser = {
  id: 'e1000000-0000-4000-aa00-000000000004',
  email: 'inc-comp-senior-done@test.spec',
  displayName: 'Inc Comp Senior Done',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 40,
  legalFullName: null,
}
const JUNIOR: SessionUser = {
  id: 'e1000000-0000-4000-aa00-000000000005',
  email: 'inc-comp-junior@test.spec',
  displayName: 'Inc Comp Junior',
  avatarUrl: null,
  role: 'JUNIOR',
  seniorSharePercent: 0,
  legalFullName: null,
}
const HR: SessionUser = {
  id: 'e1000000-0000-4000-aa00-000000000006',
  email: 'inc-comp-hr@test.spec',
  displayName: 'Inc Comp HR',
  avatarUrl: null,
  role: 'HR',
  seniorSharePercent: 0,
  legalFullName: null,
}
const ACCOUNTANT: SessionUser = {
  id: 'e1000000-0000-4000-aa00-000000000007',
  email: 'inc-comp-accountant@test.spec',
  displayName: 'Inc Comp Accountant',
  avatarUrl: null,
  role: 'ACCOUNTANT',
  seniorSharePercent: 0,
  legalFullName: null,
}
const DROP: SessionUser = {
  id: 'e1000000-0000-4000-aa00-000000000008',
  email: 'inc-comp-drop@test.spec',
  displayName: 'Inc Comp Drop',
  avatarUrl: null,
  role: 'DROP',
  seniorSharePercent: 0,
  legalFullName: null,
}

// ── Spec-namespaced project IDs ──────────────────────────────────────────────
const PROJ_LAG_SUBMITTED = 'e1000000-0000-4000-bb00-000000000001' // SENIOR_LAG, has VALIDATED income
const PROJ_LAG_MISSING = 'e1000000-0000-4000-bb00-000000000002' // SENIOR_LAG, no counted income
const PROJ_DONE = 'e1000000-0000-4000-bb00-000000000003' // SENIOR_DONE, VALIDATED income → 1/1
const PROJ_ADMIN = 'e1000000-0000-4000-bb00-000000000004' // ADMIN_OWNER, ADMIN_INCOME PAID → 1/1
const PROJ_ARCHIVED = 'e1000000-0000-4000-bb00-000000000005' // SENIOR_LAG, archived → must NOT be in N
const PROJ_DROP = 'e1000000-0000-4000-bb00-000000000006' // SENIOR_DONE senior + DROP dropId

// ── Spec-namespaced transaction IDs ──────────────────────────────────────────
const TX_LAG_VALIDATED = 'e1000000-0000-4000-cc00-000000000001' // PROJ_LAG_SUBMITTED VALIDATED
const TX_DONE_VALIDATED = 'e1000000-0000-4000-cc00-000000000002' // PROJ_DONE VALIDATED
const TX_ADMIN_PAID = 'e1000000-0000-4000-cc00-000000000003' // PROJ_ADMIN ADMIN_INCOME PAID
const TX_LAG_PENDING = 'e1000000-0000-4000-cc00-000000000004' // PROJ_LAG_MISSING PENDING-only (badge)
const TX_DROP_VALIDATED = 'e1000000-0000-4000-cc00-000000000005' // PROJ_DROP DROP_INCOME VALIDATED

const TEST_USER_IDS = [
  ADMIN.id,
  ADMIN_OWNER.id,
  SENIOR_LAG.id,
  SENIOR_DONE.id,
  JUNIOR.id,
  HR.id,
  ACCOUNTANT.id,
  DROP.id,
]
const TEST_PROJECT_IDS = [
  PROJ_LAG_SUBMITTED,
  PROJ_LAG_MISSING,
  PROJ_DONE,
  PROJ_ADMIN,
  PROJ_ARCHIVED,
  PROJ_DROP,
]
const TEST_TX_IDS = [
  TX_LAG_VALIDATED,
  TX_DONE_VALIDATED,
  TX_ADMIN_PAID,
  TX_LAG_PENDING,
  TX_DROP_VALIDATED,
]

// ── Sentinel controller — mirrors the live /finance/income-compliance route ──
const TX_SERVICE = 'TX_SERVICE_INC_COMP'

@Controller('finance')
class SentinelFinanceController {
  constructor(@Inject(TX_SERVICE) private readonly svc: TransactionsService) {}

  @Get('income-compliance')
  @Roles('ADMIN', 'ACCOUNTANT')
  incomeCompliance(@CurrentUser() user: SessionUser, @Query() query: unknown) {
    const { month } = incomeComplianceQuerySchema.parse(query ?? {})
    return this.svc.getIncomeComplianceOverview(user, month)
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
class IncomeComplianceTestModule {}

// ── Suite ───────────────────────────────────────────────────────────────────
describe('income-compliance — real backend integration (real DB, no mocks)', () => {
  let app: NestFastifyApplication
  let jwt: JwtService
  let dbSvc: DatabaseService

  const now = new Date()
  const thisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 15))
  const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15))

  async function cleanup(db: DatabaseService['db']): Promise<void> {
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
        console.warn('[income-compliance integration] SKIPPED — projects table not found')
        dbAvailable = false
        return
      }
    } catch {
      console.warn(
        '[income-compliance integration] SKIPPED — no DB reachable at DATABASE_URL (expected in CI unit job)',
      )
      dbAvailable = false
      return
    }

    const moduleRef = await Test.createTestingModule({
      imports: [IncomeComplianceTestModule],
    }).compile()

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    await app.register(cookie, { secret: 'income-compliance-integration-cookie-secret' })
    app.setGlobalPrefix('api')
    await app.init()
    await app.getHttpAdapter().getInstance().ready()

    jwt = moduleRef.get(JwtService)
    dbSvc = app.get(DatabaseService)
    const db = dbSvc.db

    await cleanup(db)

    // ── Seed users ──────────────────────────────────────────────────────────
    await db
      .insert(users)
      .values(
        [ADMIN, ADMIN_OWNER, SENIOR_LAG, SENIOR_DONE, JUNIOR, HR, ACCOUNTANT, DROP].map((u) => ({
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
        id: PROJ_LAG_SUBMITTED,
        name: 'Lag Submitted',
        companyName: 'Acme Lag1',
        domain: 'AI',
        startDate: lastMonth,
        seniorId: SENIOR_LAG.id,
        rate: 50,
        createdAt: lastMonth,
      },
      {
        id: PROJ_LAG_MISSING,
        name: 'Lag Missing',
        companyName: 'Globex Lag2',
        domain: 'EdTech',
        startDate: lastMonth,
        seniorId: SENIOR_LAG.id,
        rate: 40,
        createdAt: lastMonth,
      },
      {
        id: PROJ_DONE,
        name: 'Done Project',
        companyName: 'Initech Done',
        domain: 'AI',
        startDate: lastMonth,
        seniorId: SENIOR_DONE.id,
        rate: 60,
        createdAt: lastMonth,
      },
      {
        id: PROJ_ADMIN,
        name: 'Admin Project',
        companyName: 'AdminCo',
        domain: 'E-Commerce',
        startDate: lastMonth,
        seniorId: ADMIN_OWNER.id,
        rate: 70,
        createdAt: lastMonth,
      },
      {
        id: PROJ_ARCHIVED,
        name: 'Archived Project',
        companyName: 'Dead Arch',
        domain: 'AI',
        startDate: lastMonth,
        seniorId: SENIOR_LAG.id,
        rate: 30,
        archivedAt: thisMonth,
        createdAt: lastMonth,
      },
      {
        id: PROJ_DROP,
        name: 'Drop Project',
        companyName: 'DropCo',
        domain: 'AI',
        startDate: lastMonth,
        seniorId: SENIOR_DONE.id,
        dropId: DROP.id,
        rate: 55,
        createdAt: lastMonth,
      },
    ])

    // ── Seed income transactions ────────────────────────────────────────────
    await db.insert(transactions).values([
      {
        // SENIOR_LAG: PROJ_LAG_SUBMITTED VALIDATED this month → counted.
        id: TX_LAG_VALIDATED,
        type: 'SENIOR_INCOME',
        status: 'VALIDATED',
        amount: '1000',
        currency: 'USD',
        receiverId: SENIOR_LAG.id,
        projectId: PROJ_LAG_SUBMITTED,
        txDate: thisMonth,
        createdAt: thisMonth,
        createdBy: SENIOR_LAG.id,
      },
      {
        // SENIOR_LAG: PROJ_LAG_MISSING only PENDING this month → NOT counted,
        // pendingValidation badge.
        id: TX_LAG_PENDING,
        type: 'SENIOR_INCOME',
        status: 'PENDING',
        amount: '500',
        currency: 'USD',
        receiverId: SENIOR_LAG.id,
        projectId: PROJ_LAG_MISSING,
        txDate: thisMonth,
        createdAt: thisMonth,
        createdBy: SENIOR_LAG.id,
      },
      {
        // SENIOR_DONE: PROJ_DONE VALIDATED → 1/1.
        id: TX_DONE_VALIDATED,
        type: 'SENIOR_INCOME',
        status: 'VALIDATED',
        amount: '2000',
        currency: 'USD',
        receiverId: SENIOR_DONE.id,
        projectId: PROJ_DONE,
        txDate: thisMonth,
        createdAt: thisMonth,
        createdBy: SENIOR_DONE.id,
      },
      {
        // ADMIN_OWNER: PROJ_ADMIN ADMIN_INCOME PAID → 1/1.
        id: TX_ADMIN_PAID,
        type: 'ADMIN_INCOME',
        status: 'PAID',
        amount: '3000',
        currency: 'USD',
        receiverId: ADMIN_OWNER.id,
        projectId: PROJ_ADMIN,
        txDate: thisMonth,
        createdAt: thisMonth,
        createdBy: ADMIN_OWNER.id,
      },
      {
        // DROP: PROJ_DROP DROP_INCOME VALIDATED → DROP 1/1. The senior owner
        // (SENIOR_DONE) of the same project gets NO SENIOR_INCOME here → so
        // SENIOR_DONE has PROJ_DROP as a missing project (income type mismatch).
        id: TX_DROP_VALIDATED,
        type: 'DROP_INCOME',
        status: 'VALIDATED',
        amount: '800',
        currency: 'USD',
        receiverId: DROP.id,
        projectId: PROJ_DROP,
        txDate: thisMonth,
        createdAt: thisMonth,
        createdBy: DROP.id,
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

  async function overviewAs(user: SessionUser): Promise<IncomeComplianceOverviewDto> {
    const res = await app.inject({
      method: 'GET',
      url: '/api/finance/income-compliance',
      cookies: { jwt: tokenFor(user) },
    })
    return incomeComplianceOverviewSchema.parse(res.json())
  }

  // ── RBAC (AC4) ──────────────────────────────────────────────────────────────
  const forbidden: Array<[string, SessionUser]> = [
    ['SENIOR', SENIOR_LAG],
    ['JUNIOR', JUNIOR],
    ['HR', HR],
    ['DROP', DROP],
  ]
  for (const [label, persona] of forbidden) {
    it(`RBAC: ${label} → 403`, async () => {
      if (!dbAvailable) return
      const res = await app.inject({
        method: 'GET',
        url: '/api/finance/income-compliance',
        cookies: { jwt: tokenFor(persona) },
      })
      expect(res.statusCode).toBe(403)
    })
  }

  it('RBAC: ADMIN → 200', async () => {
    if (!dbAvailable) return
    const res = await app.inject({
      method: 'GET',
      url: '/api/finance/income-compliance',
      cookies: { jwt: tokenFor(ADMIN) },
    })
    expect(res.statusCode).toBe(200)
  })

  it('RBAC: ACCOUNTANT → 200', async () => {
    if (!dbAvailable) return
    const res = await app.inject({
      method: 'GET',
      url: '/api/finance/income-compliance',
      cookies: { jwt: tokenFor(ACCOUNTANT) },
    })
    expect(res.statusCode).toBe(200)
  })

  it('ADMIN and ACCOUNTANT see the IDENTICAL overview (same company-wide list)', async () => {
    if (!dbAvailable) return
    const a = await overviewAs(ADMIN)
    const b = await overviewAs(ACCOUNTANT)
    expect(a).toEqual(b)
  })

  // ── X/N correctness (AC1/AC2/AC3) ─────────────────────────────────────────────
  it('SENIOR_LAG: 1/2 — only the VALIDATED project counted; PENDING is a badge', async () => {
    if (!dbAvailable) return
    const r = await overviewAs(ACCOUNTANT)
    const lag = r.receivers.find((x) => x.userId === SENIOR_LAG.id)!
    expect(lag.role).toBe('SENIOR')
    expect(lag.expected).toBe(2) // archived project excluded from N (AC3)
    expect(lag.submitted).toBe(1)
    expect(lag.pendingCount).toBe(1)
    const missing = lag.missingProjects
    expect(missing).toHaveLength(1)
    expect(missing[0]).toMatchObject({ projectId: PROJ_LAG_MISSING, pendingValidation: true })
  })

  it('archived project is NOT in the receiver denominator (AC3)', async () => {
    if (!dbAvailable) return
    const r = await overviewAs(ACCOUNTANT)
    const lag = r.receivers.find((x) => x.userId === SENIOR_LAG.id)!
    const ids = lag.missingProjects.map((p) => p.projectId)
    expect(ids).not.toContain(PROJ_ARCHIVED)
    expect(lag.expected).toBe(2)
  })

  it('SENIOR_DONE: PROJ_DONE counted (1) but PROJ_DROP missing (no SENIOR_INCOME) → 1/2', async () => {
    if (!dbAvailable) return
    const r = await overviewAs(ACCOUNTANT)
    const done = r.receivers.find((x) => x.userId === SENIOR_DONE.id)!
    expect(done.expected).toBe(2) // PROJ_DONE + PROJ_DROP (both active, senior = SENIOR_DONE)
    expect(done.submitted).toBe(1) // only PROJ_DONE has a SENIOR_INCOME
    const ids = done.missingProjects.map((p) => p.projectId)
    expect(ids).toContain(PROJ_DROP)
  })

  it('ADMIN-as-senior: ADMIN_INCOME PAID counts → 1/1, role ADMIN_SENIOR', async () => {
    if (!dbAvailable) return
    const r = await overviewAs(ACCOUNTANT)
    const adminOwner = r.receivers.find((x) => x.userId === ADMIN_OWNER.id)!
    expect(adminOwner.role).toBe('ADMIN_SENIOR')
    expect(adminOwner.expected).toBe(1)
    expect(adminOwner.submitted).toBe(1)
    expect(adminOwner.missingProjects).toHaveLength(0)
  })

  it('DROP receiver: DROP_INCOME VALIDATED → 1/1, role DROP', async () => {
    if (!dbAvailable) return
    const r = await overviewAs(ACCOUNTANT)
    const drop = r.receivers.find((x) => x.userId === DROP.id)!
    expect(drop.role).toBe('DROP')
    expect(drop.expected).toBe(1)
    expect(drop.submitted).toBe(1)
  })

  it('laggards-first sort: SENIOR_LAG / SENIOR_DONE (0.5) above ADMIN_OWNER / DROP (1.0)', async () => {
    if (!dbAvailable) return
    const r = await overviewAs(ACCOUNTANT)
    const order = r.receivers.map((x) => x.userId)
    const idxLag = order.indexOf(SENIOR_LAG.id)
    const idxAdmin = order.indexOf(ADMIN_OWNER.id)
    const idxDrop = order.indexOf(DROP.id)
    expect(idxLag).toBeLessThan(idxAdmin)
    expect(idxLag).toBeLessThan(idxDrop)
  })

  it('totals roll-up is internally consistent + reflects the seeded receivers', async () => {
    if (!dbAvailable) return
    // crm_qa is a SHARED scratch DB that may carry other active projects, so the
    // ABSOLUTE company-wide totals are not deterministic. We assert two things
    // that ARE deterministic:
    //   1. The roll-up is INTERNALLY consistent with the receivers array
    //      (Σ per-receiver figures === totals), proving the aggregation is sound.
    //   2. OUR four seeded receivers contribute exactly the expected sub-totals.
    const r = await overviewAs(ACCOUNTANT)

    // (1) Internal consistency over the FULL receivers list.
    const sumExpected = r.receivers.reduce((s, x) => s + x.expected, 0)
    const sumSubmitted = r.receivers.reduce((s, x) => s + x.submitted, 0)
    const sumPending = r.receivers.reduce((s, x) => s + x.pendingCount, 0)
    const lagging = r.receivers.filter((x) => x.submitted < x.expected).length
    const complete = r.receivers.filter((x) => x.submitted >= x.expected).length
    expect(r.totals.expectedProjects).toBe(sumExpected)
    expect(r.totals.submittedProjects).toBe(sumSubmitted)
    expect(r.totals.pendingProjects).toBe(sumPending)
    expect(r.totals.laggingReceivers).toBe(lagging)
    expect(r.totals.completeReceivers).toBe(complete)

    // (2) OUR four seeded receivers — deterministic sub-totals.
    const mine = r.receivers.filter((x) =>
      [SENIOR_LAG.id, SENIOR_DONE.id, ADMIN_OWNER.id, DROP.id].includes(x.userId),
    )
    expect(mine).toHaveLength(4)
    expect(mine.reduce((s, x) => s + x.expected, 0)).toBe(6) // 2+2+1+1
    expect(mine.reduce((s, x) => s + x.submitted, 0)).toBe(4) // 1+1+1+1
    expect(mine.reduce((s, x) => s + x.pendingCount, 0)).toBe(1) // PROJ_LAG_MISSING
    expect(mine.filter((x) => x.submitted >= x.expected)).toHaveLength(2) // ADMIN_OWNER + DROP
    expect(mine.filter((x) => x.submitted < x.expected)).toHaveLength(2) // SENIOR_LAG + SENIOR_DONE
  })
})

// ── SHIPPING-ROUTE GATE ───────────────────────────────────────────────────────
// Prove the RBAC gate is on the LIVE production controller, not just the test
// sentinel. These assertions read the decorator metadata DIRECTLY off the
// production `FinanceSummaryController`. They run WITHOUT a DB, so they always
// execute (mirrors senior-summary.integration.spec.ts).
describe('income-compliance — SHIPPING route carries the RBAC gate (production controller)', () => {
  const reflector = new Reflector()

  it('getIncomeCompliance handler ships @Roles(ADMIN, ACCOUNTANT)', () => {
    const roles = reflector.get<string[]>(
      ROLES_KEY,
      FinanceSummaryController.prototype.getIncomeCompliance,
    )
    expect(roles).toEqual(['ADMIN', 'ACCOUNTANT'])
  })

  it('FinanceSummaryController is guarded by @UseGuards(RolesGuard) at class level', () => {
    const guards = Reflect.getMetadata('__guards__', FinanceSummaryController) as
      | unknown[]
      | undefined
    expect(guards).toBeDefined()
    expect(guards).toContain(RolesGuard)
  })
})
