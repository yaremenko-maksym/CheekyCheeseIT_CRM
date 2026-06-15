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
import type { SessionUser } from '@crm/shared'
import { financeSummarySchema } from '@crm/shared'

import { JwtAuthGuard } from '../auth/jwt.guard'
import { CurrentUser } from '../auth/current-user.decorator'
import { DatabaseService } from '../database/database.service'
import { TransactionsService } from './transactions.service'
import { transactions, users } from '../database/schema'
import * as schema from '../database/schema'

/**
 * task-accountant-stats — GET /api/finance/summary real-backend RBAC integration
 * spec (real Postgres, no mocks). AC4.
 *
 * WHY (feedback_mocked_e2e_guards, recurred 3×): mocked E2E gives false
 * confidence for endpoints behind guards. /crm/stats now lets ACCOUNTANT view
 * the economic P&L, which is fed by GET /api/finance/summary
 * (TransactionsService.getSummary). This spec exercises the REAL service against
 * REAL PostgreSQL so the RBAC guard is proven against an actual JWT + Fastify
 * request, not a unit stub:
 *
 *   - ACCOUNTANT → 200 (economic data is the accountant's profile surface)
 *   - ADMIN      → 200 (unchanged)
 *   - SENIOR / JUNIOR / HR / DROP → 403 (никакой утечки payment-routing config)
 *
 * The unit-level RBAC is also covered in transactions.get-summary.spec.ts; this
 * spec pins the SAME guarantee at the HTTP boundary on a real DB.
 *
 * DB-SKIP-GUARD: dbAvailable=false when DATABASE_URL unreachable OR the
 * `transactions` table is absent → every test returns early and stays green
 * (so the CI unit job without a DB is unaffected).
 *
 * Run against a scratch DB (NEVER the live crm_db):
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_acct_stats \
 *     pnpm --filter @crm/api test -- transactions.summary.rbac.integration
 */

const JWT_SECRET = 'summary-rbac-integration-secret-32chars'

// ── Personas — stable IDs namespaced to THIS spec ───────────────────────────
const ACCOUNTANT: SessionUser = {
  id: '5a111111-0000-4000-aa00-000000000001',
  email: 'sum-rbac-accountant@test.spec',
  displayName: 'Sum RBAC Accountant',
  avatarUrl: null,
  role: 'ACCOUNTANT',
  seniorSharePercent: 0,
  legalFullName: null,
}
const ADMIN: SessionUser = {
  id: '5a111111-0000-4000-aa00-000000000002',
  email: 'sum-rbac-admin@test.spec',
  displayName: 'Sum RBAC Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 26,
  legalFullName: null,
}
const SENIOR: SessionUser = {
  id: '5a111111-0000-4000-aa00-000000000003',
  email: 'sum-rbac-senior@test.spec',
  displayName: 'Sum RBAC Senior',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}
const JUNIOR: SessionUser = {
  id: '5a111111-0000-4000-aa00-000000000004',
  email: 'sum-rbac-junior@test.spec',
  displayName: 'Sum RBAC Junior',
  avatarUrl: null,
  role: 'JUNIOR',
  seniorSharePercent: 0,
  legalFullName: null,
}
const HR: SessionUser = {
  id: '5a111111-0000-4000-aa00-000000000005',
  email: 'sum-rbac-hr@test.spec',
  displayName: 'Sum RBAC HR',
  avatarUrl: null,
  role: 'HR',
  seniorSharePercent: 0,
  legalFullName: null,
}
const DROP: SessionUser = {
  id: '5a111111-0000-4000-aa00-000000000006',
  email: 'sum-rbac-drop@test.spec',
  displayName: 'Sum RBAC Drop',
  avatarUrl: null,
  role: 'DROP',
  seniorSharePercent: 0,
  legalFullName: null,
}

const TEST_USER_IDS = [ACCOUNTANT.id, ADMIN.id, SENIOR.id, JUNIOR.id, HR.id, DROP.id]
// Spec-namespaced transaction ID so cleanup is surgical.
const TX_INCOME = '5a111111-0000-4000-cc00-000000000001'
const TEST_TX_IDS = [TX_INCOME]

// ── Sentinel controller — mirrors the real /finance/summary route ───────────
const TX_SERVICE = 'TX_SERVICE_SUM_RBAC'

@Controller('finance')
class SentinelFinanceController {
  constructor(@Inject(TX_SERVICE) private readonly svc: TransactionsService) {}

  @Get('summary')
  getSummary(@CurrentUser() user: SessionUser) {
    return this.svc.getSummary(user)
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
    // getSummary is a read-only aggregate over transactions/users — invoice /
    // documents collaborators are never touched, so they are stubbed.
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
  ],
})
class SummaryRbacTestModule {}

// ── Suite ───────────────────────────────────────────────────────────────────
describe('finance/summary — real backend RBAC integration (real DB, no mocks)', () => {
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
        console.warn('[summary-rbac integration] SKIPPED — transactions table not found')
        dbAvailable = false
        return
      }
    } catch {
      console.warn(
        '[summary-rbac integration] SKIPPED — no DB reachable at DATABASE_URL (expected in CI unit job)',
      )
      dbAvailable = false
      return
    }

    const moduleRef = await Test.createTestingModule({
      imports: [SummaryRbacTestModule],
    }).compile()

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    await app.register(cookie, { secret: 'summary-rbac-integration-cookie-secret' })
    app.setGlobalPrefix('api')
    await app.init()
    await app.getHttpAdapter().getInstance().ready()

    jwt = moduleRef.get(JwtService)
    dbSvc = app.get(DatabaseService)
    const db = dbSvc.db

    // Surgical cleanup of leftover rows from a previous run BEFORE seeding.
    await db.delete(transactions).where(inArray(transactions.id, TEST_TX_IDS))
    await db.delete(users).where(inArray(users.id, TEST_USER_IDS))

    // Seed personas + one PAID income row so the 200 responses carry real data.
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

    await db.insert(transactions).values({
      id: TX_INCOME,
      type: 'ADMIN_INCOME',
      status: 'PAID',
      amount: '1000',
      currency: 'USDT',
      receiverId: ADMIN.id,
      createdAt: new Date(),
      createdBy: ADMIN.id,
    })
  }, 30_000)

  afterAll(async () => {
    if (!dbAvailable) return
    try {
      const db = dbSvc.db
      await db.delete(transactions).where(inArray(transactions.id, TEST_TX_IDS))
      await db.delete(users).where(inArray(users.id, TEST_USER_IDS))
    } catch {
      // non-fatal
    }
    await app.close()
  }, 15_000)

  function tokenFor(user: SessionUser): string {
    return jwt.sign(user)
  }

  async function summaryStatus(user: SessionUser): Promise<number> {
    const res = await app.inject({
      method: 'GET',
      url: '/api/finance/summary',
      cookies: { jwt: tokenFor(user) },
    })
    return res.statusCode
  }

  // ── Allowed (AC4): economic data reaches ACCOUNTANT + ADMIN ─────────────────
  it('ACCOUNTANT → 200 (economic P&L surface)', async () => {
    if (!dbAvailable) return
    expect(await summaryStatus(ACCOUNTANT)).toBe(200)
  })

  it('ADMIN → 200 (unchanged)', async () => {
    if (!dbAvailable) return
    expect(await summaryStatus(ADMIN)).toBe(200)
  })

  // ── Forbidden (AC4): no leak to non-economic roles ──────────────────────────
  const forbidden: Array<[string, SessionUser]> = [
    ['SENIOR', SENIOR],
    ['JUNIOR', JUNIOR],
    ['HR', HR],
    ['DROP', DROP],
  ]
  for (const [label, persona] of forbidden) {
    it(`${label} → 403 (payment-routing config never leaks)`, async () => {
      if (!dbAvailable) return
      expect(await summaryStatus(persona)).toBe(403)
    })
  }

  // ── Wire-shape: the ACCOUNTANT payload is a valid finance summary ───────────
  it('ACCOUNTANT payload is schema-valid + carries the economic fields', async () => {
    if (!dbAvailable) return
    const res = await app.inject({
      method: 'GET',
      url: '/api/finance/summary',
      cookies: { jwt: tokenFor(ACCOUNTANT) },
    })
    expect(res.statusCode).toBe(200)
    // Throws if the wire shape drifts from the shared contract.
    const body = financeSummarySchema.parse(res.json())
    // Economic fields that drive the accountant's P&L view are present + finite.
    for (const n of [body.totalIncome, body.totalExpenses, body.totalSalaries, body.netBalance]) {
      expect(Number.isFinite(n)).toBe(true)
    }
    expect(Array.isArray(body.monthly)).toBe(true)
  })
})
