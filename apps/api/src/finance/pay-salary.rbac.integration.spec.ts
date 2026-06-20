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
import { TransactionsController } from './transactions.controller'
import { TransactionsService } from './transactions.service'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'
import type { EtherscanService } from './etherscan.service'
import type { NbuCurrencyService } from './nbu-currency.service'
import { transactions, users } from '../database/schema'
import * as schema from '../database/schema'

/**
 * #254 review LOW fix (FM-5 guard-test gate) — REAL-controller RBAC integration
 * for PATCH /transactions/:id/pay.
 *
 * WHY: the service-side `if (currentUser.role !== 'ADMIN') throw ForbiddenException()`
 * proves the SERVICE check but NOT that @Roles('ADMIN') + @UseGuards(RolesGuard)
 * is wired on the HTTP route. This spec stands up the REAL TransactionsController
 * behind the REAL JwtAuthGuard + RolesGuard against REAL PostgreSQL and asserts:
 *
 *   PATCH /transactions/:id/pay
 *     SENIOR / ACCOUNTANT / JUNIOR / HR / DROP → 403 (guard fires before handler)
 *     ADMIN                                    → 2xx (handler reached, tx PAID)
 *
 * Dropping @Roles/@UseGuards from the route turns THIS spec red — the guarantee
 * is real. Pattern mirrors payout-manual-confirm.rbac.integration.spec.ts.
 *
 * Run against a scratch DB (NEVER the live crm_db):
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_qa \
 *     pnpm --filter @crm/api test -- pay-salary.rbac.integration
 */

const JWT_SECRET = 'pay-salary-rbac-integration-secret-32chars'

// ── Personas — stable IDs namespaced to THIS spec ───────────────────────────
const ADMIN: SessionUser = {
  id: 'aa220000-0000-4000-aa00-000000000001',
  email: 'ps-admin@test.spec',
  displayName: 'PS Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 0,
  legalFullName: null,
}
const ACCOUNTANT: SessionUser = {
  ...ADMIN,
  id: 'aa220000-0000-4000-aa00-000000000002',
  email: 'ps-acct@test.spec',
  displayName: 'PS Accountant',
  role: 'ACCOUNTANT',
}
const SENIOR: SessionUser = {
  ...ADMIN,
  id: 'aa220000-0000-4000-aa00-000000000003',
  email: 'ps-senior@test.spec',
  displayName: 'PS Senior',
  role: 'SENIOR',
  seniorSharePercent: 26,
}
const JUNIOR: SessionUser = {
  ...ADMIN,
  id: 'aa220000-0000-4000-aa00-000000000004',
  email: 'ps-junior@test.spec',
  displayName: 'PS Junior',
  role: 'JUNIOR',
}
const HR: SessionUser = {
  ...ADMIN,
  id: 'aa220000-0000-4000-aa00-000000000005',
  email: 'ps-hr@test.spec',
  displayName: 'PS HR',
  role: 'HR',
}
const DROP: SessionUser = {
  ...ADMIN,
  id: 'aa220000-0000-4000-aa00-000000000006',
  email: 'ps-drop@test.spec',
  displayName: 'PS Drop',
  role: 'DROP',
}

const ALL = [ADMIN, ACCOUNTANT, SENIOR, JUNIOR, HR, DROP]
const TEST_USER_IDS = ALL.map((u) => u.id)

// ── Stub collaborators — irrelevant to the RBAC guard chain ──────────────────
const fakeNbu: Pick<NbuCurrencyService, 'getRates'> = {
  getRates: () =>
    Promise.resolve({
      usdUah: '40.0000',
      usdtUah: '40.0000',
      eurUah: '44.0000',
      date: '20260620',
    }),
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
} as never
const stubDocuments = {} as never

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
  controllers: [TransactionsController],
  providers: [
    Reflector,
    // esbuild (vitest) does NOT emit `design:paramtypes`, so the service is wired
    // via an explicit `useFactory` keyed on the real class token — which the
    // controller's `@Inject(TransactionsService)` resolves. 5-arg constructor
    // matches the production signature.
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
    // Authentication: global JwtAuthGuard (populates req.user). The
    // method-scoped `@UseGuards(RolesGuard)` on paySalary is overridden with a
    // properly-constructed RolesGuard so it enforces @Roles against a working
    // Reflector. Pattern: payout-manual-confirm.rbac.integration.spec.ts.
    {
      provide: APP_GUARD,
      useFactory: (jwtSvc: JwtService, reflector: Reflector) => new JwtAuthGuard(jwtSvc, reflector),
      inject: [JwtService, Reflector],
    },
  ],
})
class PaySalaryRbacTestModule {}

describe('pay-salary route — real backend RBAC integration (real DB, no mocks)', () => {
  let app: NestFastifyApplication
  let jwt: JwtService
  let dbSvc: DatabaseService

  beforeAll(async () => {
    try {
      const probe = new Pool({ connectionString: process.env['DATABASE_URL'] })
      await probe.query('SELECT 1')
      const check = await probe.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name='transactions' AND column_name='salary_month' LIMIT 1`,
      )
      await probe.end()
      if (check.rowCount === 0) {
        console.warn('[pay-salary rbac] SKIPPED — transactions table not found / missing column')
        dbAvailable = false
        return
      }
    } catch {
      console.warn('[pay-salary rbac] SKIPPED — no DB reachable at DATABASE_URL')
      dbAvailable = false
      return
    }

    const moduleRef = await Test.createTestingModule({
      imports: [PaySalaryRbacTestModule],
    })
      // Real TransactionsController is decorated `@UseGuards(RolesGuard)` on the
      // paySalary method. In a standalone Test module the method-scoped guard is
      // not auto-wired with a Reflector, so we override it with a
      // fully-constructed instance — this exercises the REAL RolesGuard logic
      // (getAllAndOverride(@Roles) → 403) against the live JWT request.
      .overrideGuard(RolesGuard)
      .useValue(new RolesGuard(new Reflector()))
      .compile()

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    await app.register(cookie, { secret: 'pay-salary-rbac-cookie-secret' })
    app.setGlobalPrefix('api')
    await app.init()
    await app.getHttpAdapter().getInstance().ready()

    jwt = moduleRef.get(JwtService)
    dbSvc = app.get(DatabaseService)

    // Surgical cleanup of leftover rows from a prior run.
    await dbSvc.db.delete(transactions).where(inArray(transactions.createdBy, TEST_USER_IDS))
    await dbSvc.db.delete(users).where(inArray(users.id, TEST_USER_IDS))

    await dbSvc.db
      .insert(users)
      .values(
        ALL.map((u) => ({
          id: u.id,
          email: u.email,
          displayName: u.displayName,
          role: u.role,
          seniorSharePercent: u.role === 'SENIOR' ? 26 : 0,
          googleId: `test-google-${u.id}`,
        })),
      )
      .onConflictDoNothing()
  }, 30_000)

  afterAll(async () => {
    if (!dbAvailable) return
    try {
      await dbSvc.db.delete(transactions).where(inArray(transactions.createdBy, TEST_USER_IDS))
      await dbSvc.db.delete(users).where(inArray(users.id, TEST_USER_IDS))
    } catch {
      // non-fatal
    }
    await app.close()
  }, 15_000)

  const tokenFor = (u: SessionUser) => jwt.sign(u)

  /** Seed a fresh PENDING SALARY tx authored by ADMIN, return its id. */
  async function seedPendingSalary(): Promise<string> {
    const [tx] = await dbSvc.db
      .insert(transactions)
      .values({
        type: 'SALARY',
        status: 'PENDING',
        amount: '500',
        currency: 'USDT',
        receiverId: JUNIOR.id,
        createdBy: ADMIN.id,
        salaryMonth: '2026-06',
      })
      .returning()
    return tx!.id
  }

  async function paySalary(user: SessionUser, txId: string): Promise<number> {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/transactions/${txId}/pay`,
      cookies: { jwt: tokenFor(user) },
      // paySalarySchema requires fundingSource + currency (both mandatory).
      // ADMIN_PERSONAL path: payerAdminId must be a valid ADMIN in the DB.
      payload: { fundingSource: 'ADMIN_PERSONAL', payerAdminId: ADMIN.id, currency: 'USDT' },
    })
    return res.statusCode
  }

  // ── 403: non-ADMIN roles are blocked at the HTTP guard (before handler) ──────
  // Each 403 proves the guard fired BEFORE the handler; a leaked handler would
  // have flipped the tx to PAID (or returned 400 on a business-logic mismatch).
  for (const persona of [SENIOR, ACCOUNTANT, JUNIOR, HR, DROP]) {
    it(`PATCH :id/pay — ${persona.role} → 403 (guard fires before handler)`, async () => {
      if (!dbAvailable) return
      const txId = await seedPendingSalary()
      const code = await paySalary(persona, txId)
      expect(code).toBe(403)

      // Defense-in-depth assertion: the tx must still be PENDING (handler never ran).
      const row = await dbSvc.db.query.transactions.findFirst({
        where: (t, { eq }) => eq(t.id, txId),
      })
      expect(row?.status).toBe('PENDING')
    })
  }

  // ── 2xx: ADMIN reaches the handler ────────────────────────────────────────
  it('PATCH :id/pay — ADMIN → 2xx (reaches handler, tx PAID)', async () => {
    if (!dbAvailable) return
    const txId = await seedPendingSalary()
    const code = await paySalary(ADMIN, txId)
    expect(code).toBeGreaterThanOrEqual(200)
    expect(code).toBeLessThan(300)

    const row = await dbSvc.db.query.transactions.findFirst({
      where: (t, { eq }) => eq(t.id, txId),
    })
    expect(row?.status).toBe('PAID')
  })
})
