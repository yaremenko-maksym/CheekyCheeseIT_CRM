import { Controller, Get, Global, Inject, Module, Param, Query } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { JwtModule, JwtService } from '@nestjs/jwt'
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import cookie from '@fastify/cookie'
import { drizzle } from 'drizzle-orm/node-postgres'
import { inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SessionUser, TotalEarnedDto } from '@crm/shared'
import { totalEarnedSchema } from '@crm/shared'

import { JwtAuthGuard } from '../auth/jwt.guard'
import { CurrentUser } from '../auth/current-user.decorator'
import { DatabaseService } from '../database/database.service'
import { BalanceService } from './balance.service'
import { NbuCurrencyService } from './nbu-currency.service'
import { projects, transactions, users } from '../database/schema'
import * as schema from '../database/schema'

/**
 * total-earned — real-backend integration spec (real Postgres, no mocks).
 * Covers task-profile-earned-balance AC3 (RBAC 200/403) + AC4 (correct
 * totalEarned per target role over PAID rows).
 *
 * WHY (feedback_mocked_e2e_guards, recurred 3×): mocked E2E gives false
 * confidence for endpoints behind guards. This spec exercises the REAL
 * BalanceService.getTotalEarned against REAL PostgreSQL through a Fastify
 * request + JWT so:
 *   - the RBAC guard (ADMIN/ACCOUNTANT → 200, everyone else → 403) is enforced
 *     against an actual JWT request, not a unit stub, and
 *   - the PAID-aggregation runs over real rows (proving the per-role SQL path).
 *
 * All amounts use USD so convertToBase is a no-op (USD→USD) — the asserted
 * figure is independent of NBU rates. The NbuCurrencyService is stubbed with a
 * fixed rate set so the spec never reaches out to the exchange_rate table.
 *
 * DB-SKIP-GUARD: dbAvailable=false when DATABASE_URL unreachable OR the
 * `transactions` table is absent → every test returns early and stays green
 * (CI unit job without a DB is unaffected).
 *
 * Run against a scratch DB (NEVER the live crm_db):
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_te_scratch \
 *     pnpm --filter @crm/api test -- total-earned.integration
 */

const JWT_SECRET = 'total-earned-integration-secret-len-32!'

// ── Personas — stable IDs namespaced to THIS spec ───────────────────────────
const ACCOUNTANT: SessionUser = {
  id: 'fe111111-0000-4000-aa00-000000000001',
  email: 'te-accountant@test.spec',
  displayName: 'TE Accountant',
  avatarUrl: null,
  role: 'ACCOUNTANT',
  seniorSharePercent: 0,
  legalFullName: null,
}
const ADMIN: SessionUser = {
  id: 'fe111111-0000-4000-aa00-000000000002',
  email: 'te-admin@test.spec',
  displayName: 'TE Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 26,
  legalFullName: null,
}
const SENIOR: SessionUser = {
  id: 'fe111111-0000-4000-aa00-000000000003',
  email: 'te-senior@test.spec',
  displayName: 'TE Senior',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}
const JUNIOR: SessionUser = {
  id: 'fe111111-0000-4000-aa00-000000000004',
  email: 'te-junior@test.spec',
  displayName: 'TE Junior',
  avatarUrl: null,
  role: 'JUNIOR',
  seniorSharePercent: 0,
  legalFullName: null,
}
const HR: SessionUser = {
  id: 'fe111111-0000-4000-aa00-000000000005',
  email: 'te-hr@test.spec',
  displayName: 'TE HR',
  avatarUrl: null,
  role: 'HR',
  seniorSharePercent: 0,
  legalFullName: null,
}
const DROP: SessionUser = {
  id: 'fe111111-0000-4000-aa00-000000000006',
  email: 'te-drop@test.spec',
  displayName: 'TE Drop',
  avatarUrl: null,
  role: 'DROP',
  seniorSharePercent: 0,
  legalFullName: null,
}

const PROJ_ID = 'fe111111-0000-4000-bb00-000000000001'

// Spec-namespaced transaction IDs so cleanup is surgical.
const TX_JUNIOR_SALARY_PAID = 'fe111111-0000-4000-cc00-000000000001' // SALARY PAID 1000 → junior
const TX_JUNIOR_SALARY_PAID_2 = 'fe111111-0000-4000-cc00-000000000002' // SALARY PAID 500 → junior
const TX_JUNIOR_SALARY_PENDING = 'fe111111-0000-4000-cc00-000000000003' // SALARY PENDING 777 → excluded
const TX_HR_SALARY_PAID = 'fe111111-0000-4000-cc00-000000000004' // SALARY PAID 2000 → hr
const TX_SENIOR_INCOME_PAID = 'fe111111-0000-4000-cc00-000000000005' // SENIOR_INCOME PAID 3000 → senior
const TX_SENIOR_INCOME_VALIDATED = 'fe111111-0000-4000-cc00-000000000006' // SENIOR_INCOME VALIDATED 4444 → excluded
const TX_DROP_PAYOUT_PAID = 'fe111111-0000-4000-cc00-000000000007' // PAYOUT_DROP PAID 1500 → drop
const TX_DROP_INCOME_PAID = 'fe111111-0000-4000-cc00-000000000008' // DROP_INCOME PAID 250 → drop
const TX_DROP_INCOME_PENDING = 'fe111111-0000-4000-cc00-000000000009' // DROP_INCOME PENDING 999 → excluded

const TEST_USER_IDS = [ACCOUNTANT.id, ADMIN.id, SENIOR.id, JUNIOR.id, HR.id, DROP.id]
const TEST_TX_IDS = [
  TX_JUNIOR_SALARY_PAID,
  TX_JUNIOR_SALARY_PAID_2,
  TX_JUNIOR_SALARY_PENDING,
  TX_HR_SALARY_PAID,
  TX_SENIOR_INCOME_PAID,
  TX_SENIOR_INCOME_VALIDATED,
  TX_DROP_PAYOUT_PAID,
  TX_DROP_INCOME_PAID,
  TX_DROP_INCOME_PENDING,
]

// ── Sentinel controller — mirrors the real /balances/total-earned/:id route ──
const BAL_SERVICE = 'BAL_SERVICE_TOTAL_EARNED'

@Controller('balances')
class SentinelBalanceController {
  constructor(@Inject(BAL_SERVICE) private readonly svc: BalanceService) {}

  @Get('total-earned/:userId')
  totalEarned(
    @Param('userId') userId: string,
    @CurrentUser() user: SessionUser,
    @Query('currency') currency: string | undefined,
  ) {
    this.svc.assertCanReadTotalEarned(user)
    return this.svc.getTotalEarned(userId, (currency?.toUpperCase() as 'USD') || 'USD')
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
    // Stub NBU — fixed rates so the service never touches exchange_rate and the
    // figures stay deterministic. All test rows are USD so convertToBase is a
    // no-op anyway, but a stub keeps the spec hermetic.
    {
      provide: NbuCurrencyService,
      useValue: {
        getRates: () =>
          Promise.resolve({
            usdUah: '41.50',
            usdtUah: '41.50',
            eurUah: '44.80',
            date: '2026-01-01',
          }),
      } as Partial<NbuCurrencyService>,
    },
  ],
  exports: [DatabaseService, NbuCurrencyService],
})
class TestDatabaseModule {}

@Module({
  imports: [
    TestDatabaseModule,
    JwtModule.register({ secret: JWT_SECRET, signOptions: { expiresIn: '1h' } }),
  ],
  controllers: [SentinelBalanceController],
  providers: [
    Reflector,
    {
      provide: BalanceService,
      useFactory: (db: DatabaseService, nbu: NbuCurrencyService) => new BalanceService(db, nbu),
      inject: [DatabaseService, NbuCurrencyService],
    },
    { provide: BAL_SERVICE, useExisting: BalanceService },
    {
      provide: APP_GUARD,
      useFactory: (jwtSvc: JwtService, reflector: Reflector) => new JwtAuthGuard(jwtSvc, reflector),
      inject: [JwtService, Reflector],
    },
  ],
})
class TotalEarnedTestModule {}

// ── Suite ───────────────────────────────────────────────────────────────────
describe('total-earned — real backend integration (real DB, no mocks)', () => {
  let app: NestFastifyApplication
  let jwt: JwtService
  let dbSvc: DatabaseService

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
        console.warn('[total-earned integration] SKIPPED — transactions table not found')
        dbAvailable = false
        return
      }
    } catch {
      console.warn(
        '[total-earned integration] SKIPPED — no DB reachable at DATABASE_URL (expected in CI unit job)',
      )
      dbAvailable = false
      return
    }

    const moduleRef = await Test.createTestingModule({
      imports: [TotalEarnedTestModule],
    }).compile()

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    await app.register(cookie, { secret: 'total-earned-integration-cookie-secret' })
    app.setGlobalPrefix('api')
    await app.init()
    await app.getHttpAdapter().getInstance().ready()

    jwt = moduleRef.get(JwtService)
    dbSvc = app.get(DatabaseService)
    const db = dbSvc.db

    // Surgical cleanup BEFORE seeding so figures are deterministic.
    await db.delete(transactions).where(inArray(transactions.id, TEST_TX_IDS))
    await db.delete(projects).where(inArray(projects.id, [PROJ_ID]))
    await db.delete(users).where(inArray(users.id, TEST_USER_IDS))

    await db
      .insert(users)
      .values(
        [ACCOUNTANT, ADMIN, SENIOR, JUNIOR, HR, DROP].map((u) => ({
          id: u.id,
          email: u.email,
          displayName: u.displayName,
          role: u.role,
          googleId: `test-google-${u.id}`,
        })),
      )
      .onConflictDoNothing()

    await db
      .insert(projects)
      .values({
        id: PROJ_ID,
        name: 'TE Project',
        companyName: 'TE Corp',
        domain: 'ai',
        startDate: new Date('2025-01-01'),
        seniorId: SENIOR.id,
        currency: 'USD',
        rate: 1000,
      })
      .onConflictDoNothing()

    // ── Seed deterministic per-role PAID fixtures (all USD) ────────────────────
    // JUNIOR earned = 1000 + 500 = 1500 (SALARY PAID). PENDING salary excluded.
    // HR earned = 2000 (SALARY PAID).
    // SENIOR earned = 3000 (SENIOR_INCOME PAID). VALIDATED (not PAID) excluded.
    // DROP earned = 1500 (PAYOUT_DROP PAID) + 250 (DROP_INCOME PAID) = 1750.
    //   PENDING drop income excluded.
    await db.insert(transactions).values([
      {
        id: TX_JUNIOR_SALARY_PAID,
        type: 'SALARY',
        status: 'PAID',
        amount: '1000',
        currency: 'USD',
        senderId: ADMIN.id,
        receiverId: JUNIOR.id,
        salaryMonth: '2025-11',
        createdBy: ADMIN.id,
      },
      {
        id: TX_JUNIOR_SALARY_PAID_2,
        type: 'SALARY',
        status: 'PAID',
        amount: '500',
        currency: 'USD',
        senderId: ADMIN.id,
        receiverId: JUNIOR.id,
        salaryMonth: '2025-12',
        createdBy: ADMIN.id,
      },
      {
        id: TX_JUNIOR_SALARY_PENDING,
        type: 'SALARY',
        status: 'PENDING',
        amount: '777',
        currency: 'USD',
        senderId: ADMIN.id,
        receiverId: JUNIOR.id,
        salaryMonth: '2026-01',
        createdBy: ADMIN.id,
      },
      {
        id: TX_HR_SALARY_PAID,
        type: 'SALARY',
        status: 'PAID',
        amount: '2000',
        currency: 'USD',
        senderId: ADMIN.id,
        receiverId: HR.id,
        salaryMonth: '2025-12',
        createdBy: ADMIN.id,
      },
      {
        id: TX_SENIOR_INCOME_PAID,
        type: 'SENIOR_INCOME',
        status: 'PAID',
        amount: '3000',
        currency: 'USD',
        receiverId: SENIOR.id,
        projectId: PROJ_ID,
        createdBy: SENIOR.id,
      },
      {
        id: TX_SENIOR_INCOME_VALIDATED,
        type: 'SENIOR_INCOME',
        status: 'VALIDATED',
        amount: '4444',
        currency: 'USD',
        receiverId: SENIOR.id,
        projectId: PROJ_ID,
        createdBy: SENIOR.id,
      },
      {
        id: TX_DROP_PAYOUT_PAID,
        type: 'PAYOUT_DROP',
        status: 'PAID',
        amount: '1500',
        currency: 'USD',
        senderId: SENIOR.id,
        receiverId: DROP.id,
        recipientId: DROP.id,
        projectId: PROJ_ID,
        createdBy: SENIOR.id,
      },
      {
        id: TX_DROP_INCOME_PAID,
        type: 'DROP_INCOME',
        status: 'PAID',
        amount: '250',
        currency: 'USD',
        receiverId: DROP.id,
        recipientId: DROP.id,
        projectId: PROJ_ID,
        createdBy: DROP.id,
      },
      {
        id: TX_DROP_INCOME_PENDING,
        type: 'DROP_INCOME',
        status: 'PENDING',
        amount: '999',
        currency: 'USD',
        receiverId: DROP.id,
        recipientId: DROP.id,
        projectId: PROJ_ID,
        createdBy: DROP.id,
      },
    ])
  }, 30_000)

  afterAll(async () => {
    if (!dbAvailable) return
    try {
      const db = dbSvc.db
      await db.delete(transactions).where(inArray(transactions.id, TEST_TX_IDS))
      await db.delete(projects).where(inArray(projects.id, [PROJ_ID]))
      await db.delete(users).where(inArray(users.id, TEST_USER_IDS))
    } catch {
      // non-fatal
    }
    await app.close()
  }, 15_000)

  function tokenFor(user: SessionUser): string {
    return jwt.sign(user)
  }

  async function earnedFor(viewer: SessionUser, targetId: string) {
    return app.inject({
      method: 'GET',
      url: `/api/balances/total-earned/${targetId}`,
      cookies: { jwt: tokenFor(viewer) },
    })
  }

  // ── RBAC (AC3) ────────────────────────────────────────────────────────────
  const forbidden: Array<[string, SessionUser]> = [
    ['SENIOR', SENIOR],
    ['JUNIOR', JUNIOR],
    ['HR', HR],
    ['DROP', DROP],
  ]
  for (const [label, persona] of forbidden) {
    it(`RBAC: ${label} viewer → 403`, async () => {
      if (!dbAvailable) return
      // Even self-view is forbidden for non-privileged roles.
      const res = await earnedFor(persona, persona.id)
      expect(res.statusCode).toBe(403)
    })
  }

  it('RBAC: ACCOUNTANT → 200', async () => {
    if (!dbAvailable) return
    const res = await earnedFor(ACCOUNTANT, JUNIOR.id)
    expect(res.statusCode).toBe(200)
  })

  it('RBAC: ADMIN → 200', async () => {
    if (!dbAvailable) return
    const res = await earnedFor(ADMIN, JUNIOR.id)
    expect(res.statusCode).toBe(200)
  })

  // ── Schema shape (AC) ───────────────────────────────────────────────────────
  it('returns a schema-valid TotalEarnedDto', async () => {
    if (!dbAvailable) return
    const res = await earnedFor(ACCOUNTANT, JUNIOR.id)
    const parsed: TotalEarnedDto = totalEarnedSchema.parse(res.json())
    expect(parsed.userId).toBe(JUNIOR.id)
    expect(parsed.role).toBe('JUNIOR')
    expect(parsed.currency).toBe('USD')
  })

  // ── Correctness per role (AC4) ──────────────────────────────────────────────
  it('JUNIOR totalEarned = sum of PAID SALARY (excludes PENDING)', async () => {
    if (!dbAvailable) return
    const body = totalEarnedSchema.parse((await earnedFor(ADMIN, JUNIOR.id)).json())
    // 1000 + 500 PAID; 777 PENDING excluded.
    expect(Math.round(body.totalEarned * 100) / 100).toBe(1500)
    expect(Math.round((body.breakdown['salary'] ?? 0) * 100) / 100).toBe(1500)
  })

  it('HR totalEarned = sum of PAID SALARY', async () => {
    if (!dbAvailable) return
    const body = totalEarnedSchema.parse((await earnedFor(ACCOUNTANT, HR.id)).json())
    expect(Math.round(body.totalEarned * 100) / 100).toBe(2000)
  })

  it('SENIOR totalEarned = PAID SENIOR_INCOME (excludes non-PAID)', async () => {
    if (!dbAvailable) return
    const body = totalEarnedSchema.parse((await earnedFor(ADMIN, SENIOR.id)).json())
    // 3000 PAID; 4444 VALIDATED excluded.
    expect(Math.round(body.totalEarned * 100) / 100).toBe(3000)
    expect(Math.round((body.breakdown['income'] ?? 0) * 100) / 100).toBe(3000)
  })

  it('DROP totalEarned = PAID PAYOUT_DROP + PAID DROP_INCOME (excludes PENDING)', async () => {
    if (!dbAvailable) return
    const body = totalEarnedSchema.parse((await earnedFor(ACCOUNTANT, DROP.id)).json())
    // 1500 payout + 250 income PAID; 999 PENDING excluded.
    expect(Math.round(body.totalEarned * 100) / 100).toBe(1750)
    expect(Math.round((body.breakdown['payout'] ?? 0) * 100) / 100).toBe(1500)
    expect(Math.round((body.breakdown['income'] ?? 0) * 100) / 100).toBe(250)
  })

  it('amounts are always finite numbers (no NULL/NaN leak)', async () => {
    if (!dbAvailable) return
    const body = totalEarnedSchema.parse((await earnedFor(ADMIN, SENIOR.id)).json())
    expect(Number.isFinite(body.totalEarned)).toBe(true)
    for (const v of Object.values(body.breakdown)) {
      expect(Number.isFinite(v)).toBe(true)
    }
  })
})
