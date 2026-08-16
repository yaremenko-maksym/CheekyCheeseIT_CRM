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
import { type SessionUser } from '@crm/shared'

import { JwtAuthGuard } from '../auth/jwt.guard'
import { RolesGuard } from '../common/guards/roles.guard'
import { DatabaseService } from '../database/database.service'
import { TransactionsController } from './transactions.controller'
import { PendingSettlementController } from './pending-settlement.controller'
import { TransactionsService } from './transactions.service'
import { PendingSettlementService } from './pending-settlement.service'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'
import type { EtherscanService } from './etherscan.service'
import type { NbuCurrencyService } from './nbu-currency.service'
import type { InvoicesService } from '../invoices/invoices.service'
import { transactions, users } from '../database/schema'
import * as schema from '../database/schema'

/**
 * Audit 2026-06-27 (findings #2/#3) — REAL-controller RBAC integration for the
 * finance endpoints whose controller-level RolesGuard was missing.
 *
 * WHY (feedback_mocked_e2e_guards, recurred 3×): a service-call test proves the
 * SERVICE check but NOT that @Roles + @UseGuards(RolesGuard) is wired on the HTTP
 * route. This spec stands up the REAL controllers behind the REAL JwtAuthGuard +
 * RolesGuard chain and asserts HTTP statusCode — removing the class-level guard
 * turns the 403 cases green-for-the-wrong-reason (handler leaks), so the test is
 * a genuine guarantee.
 *
 * Covered routes (representative of each new @Roles group):
 *   #3 TransactionsController
 *     POST /transactions/expense          ADMIN/ACCOUNTANT only → SENIOR/JUNIOR/HR/DROP 403
 *     POST /transactions/admin-income     ADMIN/ACCOUNTANT only → SENIOR 403
 *     POST /transactions/senior-income    SENIOR only           → ADMIN/HR 403
 *     POST  /transactions/drop-income      DROP only             → ADMIN 403
 *     PATCH /transactions/drop-income/:id ownership-gated       → non-DROP 403, non-owner 403
 *     DELETE /transactions/:id            ADMIN only            → ACCOUNTANT 403
 *   #2 PendingSettlementController
 *     GET  /pending-settlements/company   ADMIN/ACCOUNTANT only → SENIOR/JUNIOR 403
 *     GET  /pending-settlements/senior    ADMIN/ACCOUNTANT/SENIOR → JUNIOR/HR/DROP 403
 *
 * Run against a scratch DB (NEVER the live crm_db):
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_qa \
 *     pnpm --filter @crm/api test -- finance-controller-guards.rbac.integration
 */

const JWT_SECRET = 'finance-controller-guards-rbac-integration-secret-32c'

const ADMIN: SessionUser = {
  id: 'fc550000-0000-4000-aa00-000000000001',
  email: 'fcg-admin@test.spec',
  displayName: 'FCG Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 0,
  legalFullName: null,
}
const ACCOUNTANT: SessionUser = {
  ...ADMIN,
  id: 'fc550000-0000-4000-aa00-000000000002',
  email: 'fcg-acct@test.spec',
  displayName: 'FCG Acct',
  role: 'ACCOUNTANT',
}
const SENIOR: SessionUser = {
  ...ADMIN,
  id: 'fc550000-0000-4000-aa00-000000000003',
  email: 'fcg-senior@test.spec',
  displayName: 'FCG Senior',
  role: 'SENIOR',
  seniorSharePercent: 26,
}
const JUNIOR: SessionUser = {
  ...ADMIN,
  id: 'fc550000-0000-4000-aa00-000000000004',
  email: 'fcg-junior@test.spec',
  displayName: 'FCG Junior',
  role: 'JUNIOR',
}
const HR: SessionUser = {
  ...ADMIN,
  id: 'fc550000-0000-4000-aa00-000000000005',
  email: 'fcg-hr@test.spec',
  displayName: 'FCG HR',
  role: 'HR',
}
const DROP: SessionUser = {
  ...ADMIN,
  id: 'fc550000-0000-4000-aa00-000000000006',
  email: 'fcg-drop@test.spec',
  displayName: 'FCG Drop',
  role: 'DROP',
}

const ALL = [ADMIN, ACCOUNTANT, SENIOR, JUNIOR, HR, DROP]
const TEST_USER_IDS = ALL.map((u) => u.id)

const fakeNbu: Pick<NbuCurrencyService, 'getRates'> = {
  getRates: () =>
    Promise.resolve({ usdUah: '40.0000', usdtUah: '40.0000', eurUah: '44.0000', date: '20260620' }),
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
} as unknown as InvoicesService

let _pool: Pool | null = null
let dbAvailable = true

@Global()
@Module({
  providers: [
    {
      provide: DatabaseService,
      useFactory: (): DatabaseService => {
        _pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
        const db = drizzle(_pool, { schema })
        const instance = Object.create(DatabaseService.prototype) as DatabaseService
        Object.assign(instance, { pool: _pool, db })
        Object.defineProperty(instance, 'onModuleInit', {
          value: () => Promise.resolve(),
          writable: false,
          enumerable: false,
          configurable: true,
        })
        Object.defineProperty(instance, 'onModuleDestroy', {
          value: () => _pool?.end() ?? Promise.resolve(),
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
  controllers: [TransactionsController, PendingSettlementController],
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
      provide: PendingSettlementService,
      useFactory: (db: DatabaseService) =>
        new PendingSettlementService(db, stubInvoices, fakeNbu as NbuCurrencyService),
      inject: [DatabaseService],
    },
    {
      provide: APP_GUARD,
      useFactory: (jwtSvc: JwtService, reflector: Reflector) => new JwtAuthGuard(jwtSvc, reflector),
      inject: [JwtService, Reflector],
    },
  ],
})
class GuardsRbacTestModule {}

describe('finance controller guards — real backend RBAC integration (real DB)', () => {
  let app: NestFastifyApplication
  let jwt: JwtService
  let dbSvc: DatabaseService

  beforeAll(async () => {
    try {
      const probe = new Pool({ connectionString: process.env['DATABASE_URL'] })
      await probe.query('SELECT 1')
      const check = await probe.query(
        `SELECT table_name FROM information_schema.tables WHERE table_name='transactions' LIMIT 1`,
      )
      await probe.end()
      if (check.rowCount === 0) {
        console.warn('[finance-controller-guards rbac] SKIPPED — transactions table not found')
        dbAvailable = false
        return
      }
    } catch {
      console.warn('[finance-controller-guards rbac] SKIPPED — no DB reachable at DATABASE_URL')
      dbAvailable = false
      return
    }

    const moduleRef = await Test.createTestingModule({ imports: [GuardsRbacTestModule] })
      .overrideGuard(RolesGuard)
      .useValue(new RolesGuard(new Reflector()))
      .compile()
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    await app.register(cookie, { secret: 'finance-controller-guards-rbac-cookie-secret' })
    app.setGlobalPrefix('api')
    await app.init()
    await app.getHttpAdapter().getInstance().ready()

    jwt = moduleRef.get(JwtService)
    dbSvc = app.get(DatabaseService)
    const db = dbSvc.db

    await db.delete(transactions).where(inArray(transactions.createdBy, TEST_USER_IDS))
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
  }, 30_000)

  afterAll(async () => {
    if (!dbAvailable) return
    try {
      const db = dbSvc.db
      await db.delete(transactions).where(inArray(transactions.createdBy, TEST_USER_IDS))
      await db.delete(users).where(inArray(users.id, TEST_USER_IDS))
    } catch {
      // non-fatal
    }
    await app.close()
  }, 15_000)

  const tokenFor = (u: SessionUser) => jwt.sign(u)

  async function post(user: SessionUser, url: string, payload: unknown): Promise<number> {
    const res = await app.inject({
      method: 'POST',
      url,
      cookies: { jwt: tokenFor(user) },
      payload: payload as object,
    })
    return res.statusCode
  }
  async function del(user: SessionUser, url: string): Promise<number> {
    const res = await app.inject({ method: 'DELETE', url, cookies: { jwt: tokenFor(user) } })
    return res.statusCode
  }
  async function get(user: SessionUser, url: string): Promise<number> {
    const res = await app.inject({ method: 'GET', url, cookies: { jwt: tokenFor(user) } })
    return res.statusCode
  }
  async function patch(user: SessionUser, url: string, payload: unknown): Promise<number> {
    const res = await app.inject({
      method: 'PATCH',
      url,
      cookies: { jwt: tokenFor(user) },
      payload: payload as object,
    })
    return res.statusCode
  }

  // ── #3 TransactionsController — guard fires BEFORE handler (403, not 4xx body) ─
  describe('#3 TransactionsController @Roles guards', () => {
    const expensePayload = { amount: 10, currency: 'USDT', category: 'X' }

    for (const persona of [SENIOR, JUNIOR, HR, DROP]) {
      it(`POST /transactions/expense — ${persona.role} → 403 (ADMIN/ACCOUNTANT only)`, async () => {
        if (!dbAvailable) return
        expect(await post(persona, '/api/transactions/expense', expensePayload)).toBe(403)
      })
    }

    it('POST /transactions/admin-income — SENIOR → 403', async () => {
      if (!dbAvailable) return
      expect(
        await post(SENIOR, '/api/transactions/admin-income', {
          projectId: '00000000-0000-4000-8000-000000000000',
          amount: 10,
          currency: 'USDT',
        }),
      ).toBe(403)
    })

    for (const persona of [ADMIN, HR]) {
      it(`POST /transactions/senior-income — ${persona.role} → 403 (SENIOR only)`, async () => {
        if (!dbAvailable) return
        expect(
          await post(persona, '/api/transactions/senior-income', {
            projectId: '00000000-0000-4000-8000-000000000000',
            amount: 10,
            currency: 'USDT',
          }),
        ).toBe(403)
      })
    }

    it('POST /transactions/drop-income — ADMIN → 403 (DROP only)', async () => {
      if (!dbAvailable) return
      expect(
        await post(ADMIN, '/api/transactions/drop-income', {
          projectId: '00000000-0000-4000-8000-000000000000',
          amount: 10,
          currency: 'USDT',
        }),
      ).toBe(403)
    })

    // ── PATCH drop-income/:id — ownership-gated (no @Roles, service-side check) ─
    // BIZ-17: updateDropIncome has NO @Roles decorator — RolesGuard passes all
    // authenticated callers. The service enforces:
    //   (a) currentUser.role !== 'DROP' → ForbiddenException (403)
    //   (b) tx.receiverId !== currentUser.id → ForbiddenException (403)
    // We insert a REJECTED DROP_INCOME owned by DROP and test two cases:
    //   1. ADMIN (non-DROP role) → 403
    //   2. SENIOR (DROP-owned tx, wrong user) → 403
    describe('PATCH /transactions/drop-income/:id — ownership enforcement', () => {
      const DROP_TX_ID = 'fc550000-0000-4000-ac00-000000000001'
      const url = `/api/transactions/drop-income/${DROP_TX_ID}`
      const patchPayload = { amount: 99 }

      beforeAll(async () => {
        if (!dbAvailable) return
        const db = dbSvc.db
        await db.delete(transactions).where(inArray(transactions.id, [DROP_TX_ID]))
        // Seed a REJECTED DROP_INCOME owned by DROP (receiverId = DROP.id)
        await db.insert(transactions).values({
          id: DROP_TX_ID,
          type: 'DROP_INCOME',
          status: 'REJECTED',
          amount: '50',
          currency: 'USDT',
          senderId: null,
          receiverId: DROP.id,
          recipientId: DROP.id,
          createdBy: DROP.id,
          rejectionReason: 'test rejection',
        })
      }, 15_000)

      afterAll(async () => {
        if (!dbAvailable) return
        try {
          await dbSvc.db.delete(transactions).where(inArray(transactions.id, [DROP_TX_ID]))
        } catch {
          // non-fatal
        }
      }, 10_000)

      it('PATCH drop-income/:id — ADMIN (non-DROP role) → 403', async () => {
        if (!dbAvailable) return
        expect(await patch(ADMIN, url, patchPayload)).toBe(403)
      })

      it('PATCH drop-income/:id — SENIOR (not owner) → 403', async () => {
        if (!dbAvailable) return
        // SENIOR role triggers the `currentUser.role !== 'DROP'` check first → 403
        expect(await patch(SENIOR, url, patchPayload)).toBe(403)
      })
    })

    it('DELETE /transactions/:id — ACCOUNTANT → 403 (ADMIN only)', async () => {
      if (!dbAvailable) return
      expect(await del(ACCOUNTANT, '/api/transactions/00000000-0000-4000-8000-000000000000')).toBe(
        403,
      )
    })

    // Authorized roles pass the GUARD (they may still hit a 4xx in the handler for
    // missing data, but NOT 403 — proving the guard let them through).
    it('POST /transactions/expense — ADMIN passes the guard (not 403)', async () => {
      if (!dbAvailable) return
      expect(await post(ADMIN, '/api/transactions/expense', expensePayload)).not.toBe(403)
    })
    it('POST /transactions/expense — ACCOUNTANT passes the guard (not 403)', async () => {
      if (!dbAvailable) return
      expect(await post(ACCOUNTANT, '/api/transactions/expense', expensePayload)).not.toBe(403)
    })
  })

  // BACKLOG-followups.md item 12 — the duplicated-`txHash` query-param guard
  // (`inspectOnChainHash`, MED-S round 7) previously had ZERO controller-level
  // HTTP coverage: every existing test called `svc.inspectOnChainHash(...)`
  // directly, which never exercises Fastify's own query-string parsing — the
  // exact layer this guard defends (`?txHash=a&txHash=b` arrives as an ARRAY,
  // not a string, only at the HTTP boundary). A service-level test cannot prove
  // the guard is wired on the route at all.
  describe('GET /transactions/onchain-hash — duplicated txHash query param', () => {
    it('?txHash=a&txHash=b — ADMIN → 400 (guard fires before the service)', async () => {
      if (!dbAvailable) return
      const res = await app.inject({
        method: 'GET',
        url: '/api/transactions/onchain-hash?txHash=a&txHash=b',
        cookies: { jwt: tokenFor(ADMIN) },
      })
      expect(res.statusCode).toBe(400)
      // Positive assert: this 400 comes from the duplicated-param guard
      // specifically, not from some other 400 source down the stack.
      expect(JSON.parse(res.payload).message).toMatch(/ровно один параметр/)
    })

    it('?txHash=a&txHash=b — ACCOUNTANT → 400 too (guard is role-independent)', async () => {
      if (!dbAvailable) return
      const res = await app.inject({
        method: 'GET',
        url: '/api/transactions/onchain-hash?txHash=a&txHash=b',
        cookies: { jwt: tokenFor(ACCOUNTANT) },
      })
      expect(res.statusCode).toBe(400)
    })

    it('a single txHash param passes the duplicate-param guard (not 400 for THIS reason)', async () => {
      if (!dbAvailable) return
      const res = await app.inject({
        method: 'GET',
        url: `/api/transactions/onchain-hash?txHash=0x${'0'.repeat(64)}`,
        cookies: { jwt: tokenFor(ADMIN) },
      })
      // Proves the assertion above is about DUPLICATION, not "any query 400s":
      // a well-formed single hash reaches the service and gets a normal 200
      // (unclaimed hash — see onchain-tx-cross-path.integration.spec.ts).
      expect(res.statusCode).not.toBe(400)
    })

    it('?txHash=a&txHash=b — SENIOR → 403 (RBAC guard still runs first)', async () => {
      if (!dbAvailable) return
      const res = await app.inject({
        method: 'GET',
        url: '/api/transactions/onchain-hash?txHash=a&txHash=b',
        cookies: { jwt: tokenFor(SENIOR) },
      })
      expect(res.statusCode).toBe(403)
    })
  })

  // ── #2 PendingSettlementController @Roles guards ────────────────────────────
  describe('#2 PendingSettlementController @Roles guards', () => {
    for (const persona of [SENIOR, JUNIOR, HR, DROP]) {
      it(`GET /pending-settlements/company — ${persona.role} → 403 (ADMIN/ACCOUNTANT only)`, async () => {
        if (!dbAvailable) return
        // SENIOR is allowed on /senior but NOT /company → 403.
        expect(await get(persona, '/api/pending-settlements/company')).toBe(403)
      })
    }

    for (const persona of [ADMIN, ACCOUNTANT]) {
      it(`GET /pending-settlements/company — ${persona.role} passes the guard (not 403)`, async () => {
        if (!dbAvailable) return
        expect(await get(persona, '/api/pending-settlements/company')).not.toBe(403)
      })
    }

    for (const persona of [JUNIOR, HR, DROP]) {
      it(`GET /pending-settlements/senior — ${persona.role} → 403 (ADMIN/ACCOUNTANT/SENIOR only)`, async () => {
        if (!dbAvailable) return
        expect(await get(persona, '/api/pending-settlements/senior')).toBe(403)
      })
    }

    for (const persona of [ADMIN, ACCOUNTANT, SENIOR]) {
      it(`GET /pending-settlements/senior — ${persona.role} passes the guard (not 403)`, async () => {
        if (!dbAvailable) return
        expect(await get(persona, '/api/pending-settlements/senior')).not.toBe(403)
      })
    }
  })
})
