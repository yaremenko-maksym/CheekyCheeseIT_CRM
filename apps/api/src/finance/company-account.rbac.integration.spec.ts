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
import { ZodExceptionFilter } from '../zod-exception.filter'
import { DatabaseService } from '../database/database.service'
import { sweepOrphanConsumedTxHashes } from './__test-helpers__/consumed-tx-hashes'
import { CompanyAccountController } from './company-account.controller'
import { CompanyAccountService } from './company-account.service'
import { EtherscanService } from './etherscan.service'
import { companyAccount, transactions, users } from '../database/schema'
import * as schema from '../database/schema'

// ── REAL controller under test (green-wash fix H2) ──────────────────────────
// We exercise the PRODUCTION `CompanyAccountController` directly — NOT a sentinel
// copy. The real controller carries `@Inject(CompanyAccountService)` on its
// constructor specifically so Nest's DI can instantiate it in the vitest/esbuild
// env (which omits `design:paramtypes`). Result: dropping `@Roles`/`@UseGuards`
// from the real controller would now turn THIS spec red — the guarantee is real.

/**
 * task-company-account-backend — real-backend RBAC integration spec (AC2, FM-5).
 *
 * WHY (feedback_mocked_e2e_guards, recurred 3×): mocked E2E gives false
 * confidence for endpoints behind guards. This spec stands up the REAL
 * CompanyAccountController behind the REAL JwtAuthGuard + RolesGuard chain
 * against REAL PostgreSQL, and asserts unauthorized callers receive 403:
 *
 *   GET  /company-account              — ADMIN/ACCOUNTANT 200; SENIOR/JUNIOR/HR/DROP 403
 *   PATCH /company-account/wallet       — ADMIN 200; everyone else 403
 *   POST /company-account/deposits      — SENIOR/DROP 200; ADMIN/ACCOUNTANT/JUNIOR/HR 403
 *   POST /company-account/dividends     — ADMIN 200; everyone else 403
 *
 * EtherscanService is keyless in test → deposit verification auto-confirms the
 * happy path (the security mismatch/pending branches are covered in
 * etherscan.verify-deposit.spec.ts + company-account.deposit.integration.spec.ts).
 *
 * Run against a scratch DB (NEVER the live crm_db):
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_qa \
 *     pnpm --filter @crm/api test -- company-account.rbac.integration
 */

const JWT_SECRET = 'company-account-rbac-integration-secret-32c'
const WALLET = '0x1234567890abcdef1234567890abcdef12345678'

// ── Personas — stable IDs namespaced to THIS spec ───────────────────────────
const ADMIN: SessionUser = {
  id: 'ca111111-0000-4000-aa00-000000000001',
  email: 'ca-rbac-admin@test.spec',
  displayName: 'CA RBAC Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 0,
  legalFullName: null,
}
const ACCOUNTANT: SessionUser = {
  ...ADMIN,
  id: 'ca111111-0000-4000-aa00-000000000002',
  email: 'ca-acct@test.spec',
  displayName: 'CA Acct',
  role: 'ACCOUNTANT',
}
const SENIOR: SessionUser = {
  ...ADMIN,
  id: 'ca111111-0000-4000-aa00-000000000003',
  email: 'ca-senior@test.spec',
  displayName: 'CA Senior',
  role: 'SENIOR',
  seniorSharePercent: 26,
}
const JUNIOR: SessionUser = {
  ...ADMIN,
  id: 'ca111111-0000-4000-aa00-000000000004',
  email: 'ca-junior@test.spec',
  displayName: 'CA Junior',
  role: 'JUNIOR',
}
const HR: SessionUser = {
  ...ADMIN,
  id: 'ca111111-0000-4000-aa00-000000000005',
  email: 'ca-hr@test.spec',
  displayName: 'CA HR',
  role: 'HR',
}
const DROP: SessionUser = {
  ...ADMIN,
  id: 'ca111111-0000-4000-aa00-000000000006',
  email: 'ca-drop@test.spec',
  displayName: 'CA Drop',
  role: 'DROP',
}

const ALL = [ADMIN, ACCOUNTANT, SENIOR, JUNIOR, HR, DROP]
const TEST_USER_IDS = ALL.map((u) => u.id)
const ACCOUNT_ID = 'ca111111-0000-4000-cc00-000000000001'

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
  controllers: [CompanyAccountController],
  providers: [
    Reflector,
    // esbuild (vitest) does NOT emit `design:paramtypes` decorator metadata, so
    // the service is wired via an explicit `useFactory` keyed on the real class
    // token — which the real controller's `@Inject(CompanyAccountService)`
    // resolves (same pattern as the other finance integration specs).
    {
      provide: CompanyAccountService,
      useFactory: (db: DatabaseService) =>
        new CompanyAccountService(db, new EtherscanService({ get: () => undefined } as never)),
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
class CompanyAccountRbacTestModule {}

describe('company-account — real backend RBAC integration (real DB, no mocks)', () => {
  let app: NestFastifyApplication
  let jwt: JwtService
  let dbSvc: DatabaseService

  beforeAll(async () => {
    try {
      const probe = new Pool({ connectionString: process.env['DATABASE_URL'] })
      await probe.query('SELECT 1')
      const check = await probe.query(
        `SELECT table_name FROM information_schema.tables WHERE table_name='company_account' LIMIT 1`,
      )
      await probe.end()
      if (check.rowCount === 0) {
        console.warn('[company-account rbac] SKIPPED — company_account table not found')
        dbAvailable = false
        return
      }
    } catch {
      console.warn('[company-account rbac] SKIPPED — no DB reachable at DATABASE_URL')
      dbAvailable = false
      return
    }

    const moduleRef = await Test.createTestingModule({ imports: [CompanyAccountRbacTestModule] })
      // The real CompanyAccountController is decorated with
      // `@UseGuards(RolesGuard)`. In a standalone Test module the controller-
      // scoped guard is not auto-wired with a Reflector, so we override it with
      // a fully-constructed instance — this exercises the REAL RolesGuard logic
      // (getAllAndOverride(@Roles) → 403) against the live JWT request.
      .overrideGuard(RolesGuard)
      .useValue(new RolesGuard(new Reflector()))
      .compile()
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    await app.register(cookie, { secret: 'company-account-rbac-cookie-secret' })
    app.setGlobalPrefix('api')
    // Mirror prod (main.ts): map ZodError → 400 so schema-validation failures
    // (e.g. requisites over the length cap) return 400, not a raw 500.
    app.useGlobalFilters(new ZodExceptionFilter())
    await app.init()
    await app.getHttpAdapter().getInstance().ready()

    jwt = moduleRef.get(JwtService)
    dbSvc = app.get(DatabaseService)
    const db = dbSvc.db

    // Surgical cleanup of leftover rows.
    await db.delete(transactions).where(inArray(transactions.senderId, TEST_USER_IDS))
    await db.delete(companyAccount).where(inArray(companyAccount.id, [ACCOUNT_ID]))
    await db.delete(users).where(inArray(users.id, TEST_USER_IDS))
    // task-onchain-payment-integrity: this suite POSTs deposits with fixed
    // hashes; the consumed-hash registry outlives the deleted deposit rows by
    // design, so without this sweep the SECOND run of the suite would get a
    // legitimate 400 «хеш уже использован» instead of the expected 201.
    await sweepOrphanConsumedTxHashes(dbSvc)

    await db
      .insert(users)
      .values(
        ALL.map((u) => ({
          id: u.id,
          email: u.email,
          displayName: u.displayName,
          role: u.role,
          googleId: `test-google-${u.id}`,
        })),
      )
      .onConflictDoNothing()

    // Ensure a single company_account row exists with a configured wallet so the
    // happy-path 200s work; if the seed already created one, update it instead.
    const existing = await db.query.companyAccount.findFirst()
    if (existing) {
      await db
        .update(companyAccount)
        .set({ walletAddress: WALLET })
        .where(inArray(companyAccount.id, [existing.id]))
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
    if (!dbAvailable) return
    try {
      const db = dbSvc.db
      await db.delete(transactions).where(inArray(transactions.senderId, TEST_USER_IDS))
      await db.delete(companyAccount).where(inArray(companyAccount.id, [ACCOUNT_ID]))
      await db.delete(users).where(inArray(users.id, TEST_USER_IDS))
    } catch {
      // non-fatal
    }
    await app.close()
  }, 15_000)

  const tokenFor = (u: SessionUser) => jwt.sign(u)

  async function status(
    method: 'GET' | 'PATCH' | 'POST',
    url: string,
    user: SessionUser,
    payload?: unknown,
  ): Promise<number> {
    const res = await app.inject({
      method,
      url,
      cookies: { jwt: tokenFor(user) },
      ...(payload !== undefined && { payload }),
    })
    return res.statusCode
  }

  // ── GET /company-account — ADMIN/ACCOUNTANT 200, others 403 ─────────────────
  it('GET /company-account — ADMIN → 200', async () => {
    if (!dbAvailable) return
    expect(await status('GET', '/api/company-account', ADMIN)).toBe(200)
  })
  it('GET /company-account — ACCOUNTANT → 200', async () => {
    if (!dbAvailable) return
    expect(await status('GET', '/api/company-account', ACCOUNTANT)).toBe(200)
  })
  for (const persona of [SENIOR, JUNIOR, HR, DROP]) {
    it(`GET /company-account — ${persona.role} → 403`, async () => {
      if (!dbAvailable) return
      expect(await status('GET', '/api/company-account', persona)).toBe(403)
    })
  }

  // ── PATCH /company-account/wallet — ADMIN only ──────────────────────────────
  it('PATCH wallet — ADMIN → 200', async () => {
    if (!dbAvailable) return
    expect(
      await status('PATCH', '/api/company-account/wallet', ADMIN, { walletAddress: WALLET }),
    ).toBe(200)
  })
  for (const persona of [ACCOUNTANT, SENIOR, JUNIOR, HR, DROP]) {
    it(`PATCH wallet — ${persona.role} → 403`, async () => {
      if (!dbAvailable) return
      expect(
        await status('PATCH', '/api/company-account/wallet', persona, { walletAddress: WALLET }),
      ).toBe(403)
    })
  }

  // ── PATCH /company-account/requisites — ADMIN only ──────────────────────────
  it('PATCH requisites — ADMIN → 200', async () => {
    if (!dbAvailable) return
    expect(
      await status('PATCH', '/api/company-account/requisites', ADMIN, {
        requisitesMarkdown: '## Реквизиты\n\nООО «Тест»',
      }),
    ).toBe(200)
  })
  for (const persona of [ACCOUNTANT, SENIOR, JUNIOR, HR, DROP]) {
    it(`PATCH requisites — ${persona.role} → 403`, async () => {
      if (!dbAvailable) return
      expect(
        await status('PATCH', '/api/company-account/requisites', persona, {
          requisitesMarkdown: 'x',
        }),
      ).toBe(403)
    })
  }
  it('PATCH requisites — ADMIN, body over the length cap → 400', async () => {
    if (!dbAvailable) return
    expect(
      await status('PATCH', '/api/company-account/requisites', ADMIN, {
        requisitesMarkdown: 'a'.repeat(10001),
      }),
    ).toBe(400)
  })
  it('GET /company-account returns the requisitesMarkdown set by ADMIN', async () => {
    if (!dbAvailable) return
    const marker = '## Реквизиты\n\nIBAN UA00 0000 — round-trip marker'
    await status('PATCH', '/api/company-account/requisites', ADMIN, { requisitesMarkdown: marker })
    const res = await app.inject({
      method: 'GET',
      url: '/api/company-account',
      cookies: { jwt: tokenFor(ADMIN) },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).requisitesMarkdown).toBe(marker)
  })

  // ── POST /company-account/deposits — SENIOR/DROP only ───────────────────────
  it('POST deposits — SENIOR → 201/200', async () => {
    if (!dbAvailable) return
    const code = await status('POST', '/api/company-account/deposits', SENIOR, {
      txHashOrLink: '0x' + '1'.repeat(64),
    })
    expect([200, 201]).toContain(code)
  })
  it('POST deposits — DROP → 201/200', async () => {
    if (!dbAvailable) return
    const code = await status('POST', '/api/company-account/deposits', DROP, {
      txHashOrLink: '0x' + '2'.repeat(64),
    })
    expect([200, 201]).toContain(code)
  })
  for (const persona of [ADMIN, ACCOUNTANT, JUNIOR, HR]) {
    it(`POST deposits — ${persona.role} → 403`, async () => {
      if (!dbAvailable) return
      expect(
        await status('POST', '/api/company-account/deposits', persona, {
          txHashOrLink: '0x' + '3'.repeat(64),
        }),
      ).toBe(403)
    })
  }

  // ── POST /company-account/dividends — ADMIN only ────────────────────────────
  // MED-2: idempotencyKey is now REQUIRED in createDividendSchema; every test
  // that hits this endpoint must supply a valid UUID or it gets a 400 from Zod
  // (which would mask the 403 we're asserting). Use a stable UUID per test so
  // ADMIN-201 succeeds cleanly and non-ADMIN callers still hit the RolesGuard
  // (403) before the service even sees the body.
  // task-receipts-backend (review round 1): a dividend now also requires a
  // mandatory explorer-link receipt (USDT-only withdrawal) — the ADMIN-success
  // case needs one to reach 200/201; the 403 cases are rejected by RolesGuard
  // before Zod ever runs, so they are unaffected.
  it('POST dividends — ADMIN → 201/200', async () => {
    if (!dbAvailable) return
    const code = await status('POST', '/api/company-account/dividends', ADMIN, {
      amount: 100,
      idempotencyKey: 'ca000000-0000-4000-aa00-000000000099',
      receiptExternalUrl: 'https://etherscan.io/tx/0xcompanyaccountrbacspec',
    })
    expect([200, 201]).toContain(code)
  })
  for (const persona of [ACCOUNTANT, SENIOR, JUNIOR, HR, DROP]) {
    it(`POST dividends — ${persona.role} → 403`, async () => {
      if (!dbAvailable) return
      expect(
        await status('POST', '/api/company-account/dividends', persona, {
          amount: 100,
          idempotencyKey: 'ca000000-0000-4000-aa00-000000000099',
        }),
      ).toBe(403)
    })
  }

  // ── GET deposits/:id/status — owner-isolation (M1) ──────────────────────────
  // The @Roles guard admits SENIOR/DROP/ADMIN/ACCOUNTANT; the SERVICE then
  // enforces owner-vs-privileged. A SENIOR/DROP who is NOT the depositor must
  // get 403 even though their ROLE is admitted — this is the data-access check
  // a role-only test would miss. Real controller + real service, real DB.
  describe('GET deposits/:id/status — owner-isolation', () => {
    const DEPOSIT_ID = 'ca111111-0000-4000-dd00-000000000001'
    const url = `/api/company-account/deposits/${DEPOSIT_ID}/status`

    beforeAll(async () => {
      if (!dbAvailable) return
      const db = dbSvc.db
      await db.delete(transactions).where(inArray(transactions.id, [DEPOSIT_ID]))
      // A PENDING deposit OWNED by SENIOR (senderId = SENIOR.id).
      await db.insert(transactions).values({
        id: DEPOSIT_ID,
        type: 'COMPANY_DEPOSIT',
        status: 'PENDING',
        amount: '0',
        currency: 'USDT',
        senderId: SENIOR.id,
        senderLabel: SENIOR.displayName,
        txHash: '0x' + 'a'.repeat(64),
        createdBy: SENIOR.id,
      })
    }, 15_000)

    it('owner (SENIOR) → 200', async () => {
      if (!dbAvailable) return
      expect(await status('GET', url, SENIOR)).toBe(200)
    })
    it('non-owner (DROP, role admitted) → 403', async () => {
      if (!dbAvailable) return
      expect(await status('GET', url, DROP)).toBe(403)
    })
    it('privileged (ADMIN) → 200', async () => {
      if (!dbAvailable) return
      expect(await status('GET', url, ADMIN)).toBe(200)
    })
    it('privileged (ACCOUNTANT) → 200', async () => {
      if (!dbAvailable) return
      expect(await status('GET', url, ACCOUNTANT)).toBe(200)
    })
  })
})
