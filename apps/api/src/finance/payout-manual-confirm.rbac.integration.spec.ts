import { Global, Module } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { JwtModule, JwtService } from '@nestjs/jwt'
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import cookie from '@fastify/cookie'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq, inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type SessionUser } from '@crm/shared'

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
import { hasDatabaseUrl } from '../test/require-real-db'

/**
 * task-payout-company-wallet (Phase 8 v2) — REAL-controller RBAC integration for
 * POST /payout-requests/:id/manual-confirm (M2 green-wash fix, FM-5).
 *
 * WHY (feedback_mocked_e2e_guards, recurred 3×; lessons #227/#251): the existing
 * service-call tests (`svc.manualConfirmPayout(...) → ForbiddenException`) prove
 * the SERVICE-side role check but NOT that the @Roles('ADMIN','ACCOUNTANT') +
 * @UseGuards(RolesGuard) metadata is actually wired on the HTTP route. This spec
 * stands up the REAL PayoutRequestsController behind the REAL JwtAuthGuard +
 * RolesGuard chain against REAL PostgreSQL and asserts the HTTP statusCode:
 *
 *   POST /payout-requests/:id/manual-confirm
 *     SENIOR  → 403   DROP → 403   JUNIOR/HR → 403
 *     ADMIN   → 200/201   ACCOUNTANT → 200/201
 *
 * Dropping @Roles/@UseGuards from the real controller turns THIS spec red — the
 * guarantee is real (the controller carries @Inject(TransactionsService) so Nest
 * DI can instantiate it under vitest/esbuild, which omits design:paramtypes).
 *
 * Run against a scratch DB (NEVER the live crm_db):
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_qa \
 *     pnpm --filter @crm/api test -- payout-manual-confirm.rbac.integration
 */

const JWT_SECRET = 'payout-manual-confirm-rbac-integration-secret-32c'
const WALLET = '0xC0FFEE0000000000000000000000000000000abc'

// ── Personas — stable IDs namespaced to THIS spec ───────────────────────────
const ADMIN: SessionUser = {
  id: 'ca220000-0000-4000-aa00-000000000001',
  email: 'pmc-admin@test.spec',
  displayName: 'PMC Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 0,
  legalFullName: null,
}
const ACCOUNTANT: SessionUser = {
  ...ADMIN,
  id: 'ca220000-0000-4000-aa00-000000000002',
  email: 'pmc-acct@test.spec',
  displayName: 'PMC Acct',
  role: 'ACCOUNTANT',
}
const SENIOR: SessionUser = {
  ...ADMIN,
  id: 'ca220000-0000-4000-aa00-000000000003',
  email: 'pmc-senior@test.spec',
  displayName: 'PMC Senior',
  role: 'SENIOR',
  seniorSharePercent: 26,
}
const JUNIOR: SessionUser = {
  ...ADMIN,
  id: 'ca220000-0000-4000-aa00-000000000004',
  email: 'pmc-junior@test.spec',
  displayName: 'PMC Junior',
  role: 'JUNIOR',
}
const HR: SessionUser = {
  ...ADMIN,
  id: 'ca220000-0000-4000-aa00-000000000005',
  email: 'pmc-hr@test.spec',
  displayName: 'PMC HR',
  role: 'HR',
}
const DROP: SessionUser = {
  ...ADMIN,
  id: 'ca220000-0000-4000-aa00-000000000006',
  email: 'pmc-drop@test.spec',
  displayName: 'PMC Drop',
  role: 'DROP',
}

const ALL = [ADMIN, ACCOUNTANT, SENIOR, JUNIOR, HR, DROP]
const TEST_USER_IDS = ALL.map((u) => u.id)
const ACCOUNT_ID = 'ca220000-0000-4000-cc00-000000000001'

// ── Stub collaborators — irrelevant to the RBAC guard chain ──────────────────
// NBU rates only matter for cross-currency batches; we seed USDT incomes only.
const fakeNbu: Pick<NbuCurrencyService, 'getRates'> = {
  getRates: () =>
    Promise.resolve({ usdUah: '40.0000', usdtUah: '40.0000', eurUah: '44.0000', date: '20260620' }),
}
// Etherscan is never reached on the manual-confirm path; a no-op stub suffices.
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
    // esbuild (vitest) does NOT emit `design:paramtypes`, so the service is wired
    // via an explicit `useFactory` keyed on the real class token — which the real
    // controller's `@Inject(TransactionsService)` resolves. 5-arg constructor (db,
    // invoices, documents, nbu, etherscan) matches the production signature.
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
    // controller-scoped `@UseGuards(RolesGuard)` is overridden in beforeAll with
    // a properly-constructed RolesGuard so it enforces @Roles against a working
    // Reflector.
    {
      provide: APP_GUARD,
      useFactory: (jwtSvc: JwtService, reflector: Reflector) => new JwtAuthGuard(jwtSvc, reflector),
      inject: [JwtService, Reflector],
    },
  ],
})
class PayoutManualConfirmRbacTestModule {}

describe.skipIf(!hasDatabaseUrl())(
  'payout manual-confirm — real backend RBAC integration (real DB, no mocks)',
  () => {
    let app: NestFastifyApplication
    let jwt: JwtService
    let dbSvc: DatabaseService
    let svc: TransactionsService

    beforeAll(async () => {
      try {
        const probe = new Pool({ connectionString: process.env['DATABASE_URL'] })
        await probe.query('SELECT 1')
        const check = await probe.query(
          `SELECT table_name FROM information_schema.tables WHERE table_name='payout_requests' LIMIT 1`,
        )
        await probe.end()
        if (check.rowCount === 0) {
          throw new Error('[payout-manual-confirm rbac] FAILED — payout_requests table not found')
        }
      } catch {
        throw new Error('[payout-manual-confirm rbac] FAILED — no DB reachable at DATABASE_URL')
      }

      const moduleRef = await Test.createTestingModule({
        imports: [PayoutManualConfirmRbacTestModule],
      })
        // Real PayoutRequestsController is decorated `@UseGuards(RolesGuard)`. In a
        // standalone Test module the controller-scoped guard is not auto-wired with
        // a Reflector, so we override it with a fully-constructed instance — this
        // exercises the REAL RolesGuard logic (getAllAndOverride(@Roles) → 403)
        // against the live JWT request.
        .overrideGuard(RolesGuard)
        .useValue(new RolesGuard(new Reflector()))
        .compile()
      app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
      await app.register(cookie, { secret: 'payout-manual-confirm-rbac-cookie-secret' })
      app.setGlobalPrefix('api')
      await app.init()
      await app.getHttpAdapter().getInstance().ready()

      jwt = moduleRef.get(JwtService)
      dbSvc = app.get(DatabaseService)
      svc = app.get(TransactionsService)
      const db = dbSvc.db

      // Surgical cleanup of leftover rows from a prior run.
      await db.delete(transactions).where(inArray(transactions.createdBy, TEST_USER_IDS))
      await db.delete(transactions).where(inArray(transactions.senderId, TEST_USER_IDS))
      await db.delete(payoutRequests).where(inArray(payoutRequests.seniorId, TEST_USER_IDS))
      await db.delete(companyAccount).where(inArray(companyAccount.id, [ACCOUNT_ID]))
      await db.delete(users).where(inArray(users.id, TEST_USER_IDS))

      await db
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

      // createPayoutRequest reads companyAccount.walletAddress — ensure one exists.
      const existing = await db.query.companyAccount.findFirst()
      if (existing) {
        await db
          .update(companyAccount)
          .set({ walletAddress: WALLET })
          .where(eq(companyAccount.id, existing.id))
      } else {
        await db.insert(companyAccount).values({
          id: ACCOUNT_ID,
          walletAddress: WALLET,
          confirmationThreshold: 12,
          updatedBy: ADMIN.id,
        })
      }
    }, 30_000)

    afterAll(async () => {
      try {
        const db = dbSvc.db
        await db.delete(transactions).where(inArray(transactions.createdBy, TEST_USER_IDS))
        await db.delete(transactions).where(inArray(transactions.senderId, TEST_USER_IDS))
        await db.delete(payoutRequests).where(inArray(payoutRequests.seniorId, TEST_USER_IDS))
        await db.delete(companyAccount).where(inArray(companyAccount.id, [ACCOUNT_ID]))
        await db.delete(users).where(inArray(users.id, TEST_USER_IDS))
      } catch {
        // non-fatal
      }
      await app.close()
    }, 15_000)

    const tokenFor = (u: SessionUser) => jwt.sign(u)

    // Seed a fresh PENDING payout owned by SENIOR (real createPayoutRequest path)
    // and return its id. Each success case consumes one (confirm flips it to PAID).
    async function seedPendingPayout(): Promise<string> {
      const [income] = await dbSvc.db
        .insert(transactions)
        .values({
          type: 'SENIOR_INCOME',
          status: 'VALIDATED',
          amount: '1000',
          currency: 'USDT',
          receiverId: SENIOR.id,
          seniorSharePercent: 26,
          createdBy: SENIOR.id,
        })
        .returning()
      const pr = await svc.createPayoutRequest([income!.id], SENIOR)
      return pr.id
    }

    async function manualConfirm(user: SessionUser, payoutId: string): Promise<number> {
      const res = await app.inject({
        method: 'POST',
        url: `/api/payout-requests/${payoutId}/manual-confirm`,
        cookies: { jwt: tokenFor(user) },
        payload: { method: 'CASH' },
      })
      return res.statusCode
    }

    // ── 403: SENIOR / DROP / JUNIOR / HR are blocked at the HTTP guard ───────────
    // The payout id is a fresh PENDING one, so a 403 proves the guard fired BEFORE
    // the handler (a leaked handler would have flipped it to PAID / 200).
    for (const persona of [SENIOR, DROP, JUNIOR, HR]) {
      it(`POST manual-confirm — ${persona.role} → 403 (guard fires before handler)`, async () => {
        const payoutId = await seedPendingPayout()
        expect(await manualConfirm(persona, payoutId)).toBe(403)

        // Defense-in-depth: the payout must still be PENDING (handler never ran).
        const pr = await dbSvc.db.query.payoutRequests.findFirst({
          where: eq(payoutRequests.id, payoutId),
        })
        expect(pr?.status).toBe('PENDING')
      })
    }

    // ── 2xx: ADMIN / ACCOUNTANT reach the handler ───────────────────────────────
    it('POST manual-confirm — ADMIN → 2xx (reaches handler, payout PAID)', async () => {
      const payoutId = await seedPendingPayout()
      const code = await manualConfirm(ADMIN, payoutId)
      expect(code).toBeGreaterThanOrEqual(200)
      expect(code).toBeLessThan(300)

      const pr = await dbSvc.db.query.payoutRequests.findFirst({
        where: eq(payoutRequests.id, payoutId),
      })
      expect(pr?.status).toBe('PAID')
    })

    it('POST manual-confirm — ACCOUNTANT → 2xx (reaches handler, payout PAID)', async () => {
      const payoutId = await seedPendingPayout()
      const code = await manualConfirm(ACCOUNTANT, payoutId)
      expect(code).toBeGreaterThanOrEqual(200)
      expect(code).toBeLessThan(300)

      const pr = await dbSvc.db.query.payoutRequests.findFirst({
        where: eq(payoutRequests.id, payoutId),
      })
      expect(pr?.status).toBe('PAID')
    })
  },
)
