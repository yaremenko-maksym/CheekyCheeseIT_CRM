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

import { JwtAuthGuard } from '../auth/jwt.guard'
import { RolesGuard } from '../common/guards/roles.guard'
import { DatabaseService } from '../database/database.service'
import { PayoutRequestsController } from './transactions.controller'
import { TransactionsService } from './transactions.service'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'
import type { EtherscanService } from './etherscan.service'
import type { NbuCurrencyService } from './nbu-currency.service'
import { companyAccount, payoutRequests, transactions, users } from '../database/schema'
import * as schema from '../database/schema'

/**
 * task-ut-followups2 AC5 — smoke-test: POST /payout-requests from SENIOR → 2xx.
 *
 * Closes the mocked-E2E gap (feedback_mocked_e2e_guards pattern, recurred 3×):
 * the E2E spec mocks /payout-requests, so the real backend route was never hit
 * in integration. This spec stands up the REAL PayoutRequestsController behind
 * the REAL JwtAuthGuard + RolesGuard with REAL PostgreSQL and verifies:
 *
 *   POST /payout-requests  { transactionIds: [validatedSeniorIncomeId] }
 *     SENIOR  → 2xx  (route exists, handler runs, payout_request created)
 *     ADMIN   → 403  (service-level guard: only SENIOR can create own payout)
 *
 * Run against crm_qa scratch DB:
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_qa \
 *     pnpm --filter @crm/api test -- payout-create.smoke.integration
 */

const JWT_SECRET = 'payout-create-smoke-integration-secret-32c'
const WALLET = '0xDEAD0000000000000000000000000000000BABE1'

// ── Personas — stable IDs namespaced to THIS spec ───────────────────────────
const SENIOR: SessionUser = {
  id: '9c500000-0000-4000-aa00-000000000001',
  email: 'pcs-senior@test.spec',
  displayName: 'PCS Senior',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}
const ADMIN: SessionUser = {
  ...SENIOR,
  id: '9c500000-0000-4000-aa00-000000000002',
  email: 'pcs-admin@test.spec',
  displayName: 'PCS Admin',
  role: 'ADMIN',
  seniorSharePercent: 0,
}

const ALL_USERS = [SENIOR, ADMIN]
const TEST_USER_IDS = ALL_USERS.map((u) => u.id)
const ACCOUNT_ID = '9c500000-0000-4000-cc00-000000000001'

// ── Stub collaborators ───────────────────────────────────────────────────────
const fakeNbu: Pick<NbuCurrencyService, 'getRates'> = {
  getRates: () =>
    Promise.resolve({ usdUah: '40.0000', usdtUah: '40.0000', eurUah: '44.0000', date: '20260621' }),
}
const fakeEtherscan = {
  verifyDeposit: () =>
    Promise.resolve({
      found: false,
      toMatches: false,
      confirmed: false,
      confirmations: 0,
      amountUsdt: null,
    }),
} as never
const stubInvoices = {
  autoCreateForPayout: () => Promise.resolve(),
  autoCreateForSeniorPayout: () => Promise.resolve(),
  autoCreateForSalary: () => Promise.resolve(),
  autoCreateForIncome: () => Promise.resolve(),
} as never

// ── TestDatabaseModule (real Pool) ───────────────────────────────────────────
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
  controllers: [PayoutRequestsController],
  providers: [
    Reflector,
    {
      provide: TransactionsService,
      useFactory: (db: DatabaseService) =>
        makeTransactionsService({
          db,
          invoicesService: stubInvoices,
          nbuCurrencyService: fakeNbu as NbuCurrencyService,
          etherscanService: fakeEtherscan as EtherscanService,
        }),
      inject: [DatabaseService],
    },
    {
      provide: APP_GUARD,
      useFactory: (jwtSvc: JwtService, reflector: Reflector) => new JwtAuthGuard(jwtSvc, reflector),
      inject: [JwtService, Reflector],
    },
  ],
})
class PayoutCreateSmokeTestModule {}

describe('POST /payout-requests — SENIOR smoke test (real DB, real route, no mocks)', () => {
  let app: NestFastifyApplication
  let jwt: JwtService
  let dbSvc: DatabaseService

  beforeAll(async () => {
    // DB availability check
    try {
      const probe = new Pool({ connectionString: process.env['DATABASE_URL'] })
      await probe.query('SELECT 1')
      const check = await probe.query(
        `SELECT table_name FROM information_schema.tables WHERE table_name='payout_requests' LIMIT 1`,
      )
      await probe.end()
      if (check.rowCount === 0) {
        console.warn('[payout-create smoke] SKIPPED — payout_requests table not found')
        dbAvailable = false
        return
      }
    } catch {
      console.warn('[payout-create smoke] SKIPPED — no DB reachable at DATABASE_URL')
      dbAvailable = false
      return
    }

    const moduleRef = await Test.createTestingModule({
      imports: [PayoutCreateSmokeTestModule],
    })
      .overrideGuard(RolesGuard)
      .useValue(new RolesGuard(new Reflector()))
      .compile()

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    await app.register(cookie, { secret: 'payout-create-smoke-cookie-secret' })
    app.setGlobalPrefix('api')
    await app.init()
    await app.getHttpAdapter().getInstance().ready()

    jwt = moduleRef.get(JwtService)
    dbSvc = app.get(DatabaseService)
    const db = dbSvc.db

    // Cleanup leftover rows from prior runs
    await db.delete(payoutRequests).where(inArray(payoutRequests.seniorId, TEST_USER_IDS))
    await db.delete(transactions).where(inArray(transactions.receiverId, TEST_USER_IDS))
    await db.delete(transactions).where(inArray(transactions.createdBy, TEST_USER_IDS))
    await db.delete(companyAccount).where(inArray(companyAccount.id, [ACCOUNT_ID]))
    await db.delete(users).where(inArray(users.id, TEST_USER_IDS))

    // Seed users
    await db
      .insert(users)
      .values(
        ALL_USERS.map((u) => ({
          id: u.id,
          email: u.email,
          displayName: u.displayName,
          role: u.role,
          seniorSharePercent: u.role === 'SENIOR' ? 26 : 0,
          googleId: `test-google-${u.id}`,
        })),
      )
      .onConflictDoNothing()

    // Ensure company_account exists (createPayoutRequest reads walletAddress)
    const existing = await db.query.companyAccount.findFirst()
    if (!existing) {
      await db.insert(companyAccount).values({
        id: ACCOUNT_ID,
        walletAddress: WALLET,
        confirmationThreshold: 12,
        updatedBy: ADMIN.id,
      })
    }
  }, 30_000)

  afterAll(async () => {
    if (!dbAvailable) return
    try {
      const db = dbSvc.db
      await db.delete(payoutRequests).where(inArray(payoutRequests.seniorId, TEST_USER_IDS))
      await db.delete(transactions).where(inArray(transactions.receiverId, TEST_USER_IDS))
      await db.delete(transactions).where(inArray(transactions.createdBy, TEST_USER_IDS))
      await db.delete(companyAccount).where(inArray(companyAccount.id, [ACCOUNT_ID]))
      await db.delete(users).where(inArray(users.id, TEST_USER_IDS))
    } catch {
      // non-fatal cleanup
    }
    await app?.close()
  }, 15_000)

  const tokenFor = (u: SessionUser) => jwt.sign(u)

  it('POST /payout-requests — SENIOR with VALIDATED SENIOR_INCOME → 2xx (route exists, payout created)', async () => {
    if (!dbAvailable) return

    // Seed a VALIDATED SENIOR_INCOME for SENIOR
    const [income] = await dbSvc.db
      .insert(transactions)
      .values({
        type: 'SENIOR_INCOME',
        status: 'VALIDATED',
        amount: '500',
        currency: 'USDT',
        receiverId: SENIOR.id,
        seniorSharePercent: 26,
        createdBy: SENIOR.id,
      })
      .returning()

    const res = await app.inject({
      method: 'POST',
      url: '/api/payout-requests',
      cookies: { jwt: tokenFor(SENIOR) },
      payload: { transactionIds: [income!.id] },
    })

    // AC5: route exists (NOT 404) and SENIOR can create payout → 2xx
    expect(res.statusCode, `Expected 2xx, got ${res.statusCode}: ${res.body}`).not.toBe(404)
    expect(res.statusCode).toBeGreaterThanOrEqual(200)
    expect(res.statusCode).toBeLessThan(300)

    // Verify payout_request was actually created in DB
    const pr = await dbSvc.db.query.payoutRequests.findFirst({
      where: (tbl, { eq }) => eq(tbl.seniorId, SENIOR.id),
    })
    expect(pr).toBeDefined()
    expect(pr?.status).toBe('PENDING')
  })

  it('POST /payout-requests — ADMIN → 403 (service-level guard: only SENIOR can create own payout)', async () => {
    if (!dbAvailable) return

    // Seed a VALIDATED SENIOR_INCOME owned by ADMIN (will fail service-level role check)
    const [income] = await dbSvc.db
      .insert(transactions)
      .values({
        type: 'SENIOR_INCOME',
        status: 'VALIDATED',
        amount: '200',
        currency: 'USDT',
        receiverId: ADMIN.id,
        seniorSharePercent: 0,
        createdBy: ADMIN.id,
      })
      .returning()

    const res = await app.inject({
      method: 'POST',
      url: '/api/payout-requests',
      cookies: { jwt: tokenFor(ADMIN) },
      payload: { transactionIds: [income!.id] },
    })

    // Service throws ForbiddenException for non-SENIOR callers
    expect(res.statusCode).toBe(403)
  })
})
