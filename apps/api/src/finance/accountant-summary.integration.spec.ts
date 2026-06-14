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
import type { SessionUser, AccountantSummaryDto as AccountantSummaryDtoT } from '@crm/shared'
import { accountantSummarySchema } from '@crm/shared'

import { JwtAuthGuard } from '../auth/jwt.guard'
import { CurrentUser } from '../auth/current-user.decorator'
import { DatabaseService } from '../database/database.service'
import { TransactionsService } from './transactions.service'
import { projects, transactions, users } from '../database/schema'
import * as schema from '../database/schema'

/**
 * ACCOUNTANT Sprint 1 — accountant-summary real-backend integration spec
 * (real Postgres, no mocks). AC2 + AC1.
 *
 * WHY (feedback_mocked_e2e_guards, recurred 3×): mocked E2E gives false
 * confidence for endpoints behind guards. This spec exercises the REAL
 * TransactionsService.getAccountantSummary against REAL PostgreSQL so:
 *   - the RBAC guard (ACCOUNTANT/ADMIN → 200, everyone else → 403) is enforced
 *     against an actual JWT + Fastify request, not a unit stub, and
 *   - the KPI aggregation runs over real rows (proving the SQL/JS path).
 *
 * DB-SKIP-GUARD: dbAvailable=false when DATABASE_URL unreachable OR the
 * `transactions` table is absent → every test returns early and stays green
 * (so the CI unit job without a DB is unaffected).
 *
 * Run against a scratch DB (NEVER the live crm_db):
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_acct_s1 \
 *     pnpm --filter @crm/api test -- accountant-summary.integration
 */

const JWT_SECRET = 'accountant-summary-integration-secret-32'

// ── Personas — stable IDs namespaced to THIS spec ───────────────────────────
const ACCOUNTANT: SessionUser = {
  id: 'ac111111-0000-4000-aa00-000000000001',
  email: 'acct-sum-accountant@test.spec',
  displayName: 'Acct Sum Accountant',
  avatarUrl: null,
  role: 'ACCOUNTANT',
  seniorSharePercent: 0,
  legalFullName: null,
}
const ADMIN: SessionUser = {
  id: 'ac111111-0000-4000-aa00-000000000002',
  email: 'acct-sum-admin@test.spec',
  displayName: 'Acct Sum Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 26,
  legalFullName: null,
}
const SENIOR: SessionUser = {
  id: 'ac111111-0000-4000-aa00-000000000003',
  email: 'acct-sum-senior@test.spec',
  displayName: 'Acct Sum Senior',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}
const SENIOR2: SessionUser = {
  id: 'ac111111-0000-4000-aa00-000000000004',
  email: 'acct-sum-senior2@test.spec',
  displayName: 'Acct Sum Senior 2',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}
const JUNIOR: SessionUser = {
  id: 'ac111111-0000-4000-aa00-000000000005',
  email: 'acct-sum-junior@test.spec',
  displayName: 'Acct Sum Junior',
  avatarUrl: null,
  role: 'JUNIOR',
  seniorSharePercent: 0,
  legalFullName: null,
}
const HR: SessionUser = {
  id: 'ac111111-0000-4000-aa00-000000000006',
  email: 'acct-sum-hr@test.spec',
  displayName: 'Acct Sum HR',
  avatarUrl: null,
  role: 'HR',
  seniorSharePercent: 0,
  legalFullName: null,
}
const DROP: SessionUser = {
  id: 'ac111111-0000-4000-aa00-000000000007',
  email: 'acct-sum-drop@test.spec',
  displayName: 'Acct Sum Drop',
  avatarUrl: null,
  role: 'DROP',
  seniorSharePercent: 0,
  legalFullName: null,
}

const PROJ_ID = 'ac111111-0000-4000-bb00-000000000001'

// Spec-namespaced transaction IDs so cleanup is surgical.
const TX_PENDING_1 = 'ac111111-0000-4000-cc00-000000000001' // SENIOR_INCOME PENDING 1000
const TX_PENDING_2 = 'ac111111-0000-4000-cc00-000000000002' // DROP_INCOME PENDING 500
const TX_VALIDATED_THIS = 'ac111111-0000-4000-cc00-000000000003' // VALIDATED this month 800
const TX_VALIDATED_OLD = 'ac111111-0000-4000-cc00-000000000004' // VALIDATED last month 7777
const TX_PAID_THIS = 'ac111111-0000-4000-cc00-000000000005' // PAID this month 2000
// Sprint 2 boundary fixtures (SQL aggregation must EXCLUDE each of these):
const TX_PAID_OLD = 'ac111111-0000-4000-cc00-000000000006' // PAID last month 6666 → NOT in paidThisMonth
const TX_VALIDATED_NULL = 'ac111111-0000-4000-cc00-000000000007' // VALIDATED, validatedAt NULL 5555 → excluded
const TX_EXPENSE_PENDING = 'ac111111-0000-4000-cc00-000000000008' // EXPENSE PENDING 333 → not validatable income
const TX_SALARY_PENDING = 'ac111111-0000-4000-cc00-000000000009' // SALARY PENDING 444 → not validatable income
const TX_DEDUP_PARTY = 'ac111111-0000-4000-cc00-00000000000a' // 2nd SENIOR_INCOME for SENIOR → dedup, no new party

const TEST_USER_IDS = [ACCOUNTANT.id, ADMIN.id, SENIOR.id, SENIOR2.id, JUNIOR.id, HR.id, DROP.id]
const TEST_TX_IDS = [
  TX_PENDING_1,
  TX_PENDING_2,
  TX_VALIDATED_THIS,
  TX_VALIDATED_OLD,
  TX_PAID_THIS,
  TX_PAID_OLD,
  TX_VALIDATED_NULL,
  TX_EXPENSE_PENDING,
  TX_SALARY_PENDING,
  TX_DEDUP_PARTY,
]

// ── Sentinel controller — mirrors the real /finance/accountant-summary route ─
const TX_SERVICE = 'TX_SERVICE_ACCT_SUM'

@Controller('finance')
class SentinelFinanceController {
  constructor(@Inject(TX_SERVICE) private readonly svc: TransactionsService) {}

  @Get('accountant-summary')
  accountantSummary(@CurrentUser() user: SessionUser) {
    return this.svc.getAccountantSummary(user)
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
    // Invoices/documents collaborators are stubbed — getAccountantSummary never
    // touches them (read-only aggregate over the transactions table).
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
class AcctSummaryTestModule {}

// ── Suite ───────────────────────────────────────────────────────────────────
describe('accountant-summary — real backend integration (real DB, no mocks)', () => {
  let app: NestFastifyApplication
  let jwt: JwtService
  let dbSvc: DatabaseService

  // Baseline KPI captured BEFORE this spec inserts its own rows. The CI
  // Integration job runs against the SEEDED crm_db (not an empty DB), so the
  // global aggregate already contains seed rows. We therefore assert on the
  // DELTA contributed by this spec's fixtures, which is robust against any
  // pre-existing data (empty scratch DB OR seeded crm_db alike).
  let baseline: AccountantSummaryDtoT | null = null

  const now = new Date()
  const thisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 15))
  const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15))

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
        console.warn('[accountant-summary integration] SKIPPED — transactions table not found')
        dbAvailable = false
        return
      }
    } catch {
      console.warn(
        '[accountant-summary integration] SKIPPED — no DB reachable at DATABASE_URL (expected in CI unit job)',
      )
      dbAvailable = false
      return
    }

    const moduleRef = await Test.createTestingModule({
      imports: [AcctSummaryTestModule],
    }).compile()

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    await app.register(cookie, { secret: 'accountant-summary-integration-cookie-secret' })
    app.setGlobalPrefix('api')
    await app.init()
    await app.getHttpAdapter().getInstance().ready()

    jwt = moduleRef.get(JwtService)
    dbSvc = app.get(DatabaseService)
    const db = dbSvc.db

    // Surgical cleanup of any leftover rows from a previous run BEFORE seeding,
    // so the KPI counts are deterministic against THIS spec's data only. (The
    // assertions are scoped via delta below, but a clean slate keeps them tight.)
    await db.delete(transactions).where(inArray(transactions.id, TEST_TX_IDS))
    await db.delete(projects).where(inArray(projects.id, [PROJ_ID]))
    await db.delete(users).where(inArray(users.id, TEST_USER_IDS))

    // ── Seed users ────────────────────────────────────────────────────────────
    await db
      .insert(users)
      .values(
        [ACCOUNTANT, ADMIN, SENIOR, SENIOR2, JUNIOR, HR, DROP].map((u) => ({
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
        name: 'Acct Sum Project',
        companyName: 'AcctSum Corp',
        domain: 'ai',
        startDate: new Date('2025-01-01'),
        seniorId: SENIOR.id,
        currency: 'USDT',
        rate: 1000,
      })
      .onConflictDoNothing()

    // ── Capture baseline KPI BEFORE inserting this spec's rows ──────────────────
    // (delta-based assertions — see `baseline` declaration above). SENIOR/DROP
    // were just inserted but own NO transactions yet, so they do not yet count
    // toward recipientCount; the delta below isolates exactly this spec's effect.
    {
      const baseRes = await app.inject({
        method: 'GET',
        url: '/api/finance/accountant-summary',
        cookies: { jwt: jwt.sign(ADMIN) },
      })
      baseline = accountantSummarySchema.parse(baseRes.json())
    }

    // ── Seed transactions (deterministic KPI fixtures) ──────────────────────────
    // Δ pendingValidation: TX_PENDING_1 (1000, senior SENIOR) + TX_PENDING_2 (500,
    //   drop receiver DROP) → +count 2, +amount 1500. EXPENSE/SALARY PENDING rows
    //   (TX_EXPENSE_PENDING / TX_SALARY_PENDING) are NOT validatable income → excluded.
    // Δ validatedThisMonth: TX_VALIDATED_THIS (800, validatedAt thisMonth) → +count
    //   1, +amount 800. TX_VALIDATED_OLD (7777, validatedAt lastMonth) AND
    //   TX_VALIDATED_NULL (5555, validatedAt NULL) both excluded.
    // Δ paidThisMonth: TX_PAID_THIS (2000, createdAt thisMonth) → +2000.
    //   TX_PAID_OLD (6666, createdAt lastMonth) excluded.
    // Δ recipientCount: NEW income parties = {SENIOR, DROP} → +2 (neither owned any
    //   income row at baseline capture time). TX_DEDUP_PARTY is a 2nd SENIOR income
    //   row → COUNT(DISTINCT …) dedups SENIOR → still +2, not +3. EXPENSE/SALARY
    //   rows contribute no party.
    await db.insert(transactions).values([
      {
        id: TX_PENDING_1,
        type: 'SENIOR_INCOME',
        status: 'PENDING',
        amount: '1000',
        currency: 'USDT',
        senderId: SENIOR.id,
        projectId: PROJ_ID,
        createdAt: thisMonth,
        createdBy: SENIOR.id,
      },
      {
        id: TX_PENDING_2,
        type: 'DROP_INCOME',
        status: 'PENDING',
        amount: '500',
        currency: 'USDT',
        receiverId: DROP.id,
        recipientId: DROP.id,
        projectId: PROJ_ID,
        createdAt: thisMonth,
        createdBy: DROP.id,
      },
      {
        id: TX_VALIDATED_THIS,
        type: 'SENIOR_INCOME',
        status: 'VALIDATED',
        amount: '800',
        currency: 'USDT',
        senderId: SENIOR.id,
        projectId: PROJ_ID,
        validatedBy: ACCOUNTANT.id,
        validatedAt: thisMonth,
        createdAt: thisMonth,
        createdBy: SENIOR.id,
      },
      {
        id: TX_VALIDATED_OLD,
        type: 'SENIOR_INCOME',
        status: 'VALIDATED',
        amount: '7777',
        currency: 'USDT',
        senderId: SENIOR.id,
        projectId: PROJ_ID,
        validatedBy: ACCOUNTANT.id,
        validatedAt: lastMonth,
        createdAt: lastMonth,
        createdBy: SENIOR.id,
      },
      {
        id: TX_PAID_THIS,
        type: 'SENIOR_INCOME',
        status: 'PAID',
        amount: '2000',
        currency: 'USDT',
        senderId: SENIOR.id,
        projectId: PROJ_ID,
        createdAt: thisMonth,
        createdBy: SENIOR.id,
      },
      // ── Sprint 2 boundary fixtures — every row below must be EXCLUDED by the
      //    SQL aggregation, so it adds NOTHING to the deltas asserted later. ──
      // PAID but created last month → excluded from paidThisMonth.
      {
        id: TX_PAID_OLD,
        type: 'SENIOR_INCOME',
        status: 'PAID',
        amount: '6666',
        currency: 'USDT',
        senderId: SENIOR.id,
        projectId: PROJ_ID,
        createdAt: lastMonth,
        createdBy: SENIOR.id,
      },
      // VALIDATED but validatedAt IS NULL → excluded from validatedThisMonth
      // (the `validated_at is not null` predicate). createdAt this month so only
      // the NULL validatedAt — not the month — is what excludes it.
      {
        id: TX_VALIDATED_NULL,
        type: 'SENIOR_INCOME',
        status: 'VALIDATED',
        amount: '5555',
        currency: 'USDT',
        senderId: SENIOR.id,
        projectId: PROJ_ID,
        validatedBy: ACCOUNTANT.id,
        validatedAt: null,
        createdAt: thisMonth,
        createdBy: SENIOR.id,
      },
      // EXPENSE PENDING → not validatable income → excluded from
      // pendingValidation AND recipientCount.
      {
        id: TX_EXPENSE_PENDING,
        type: 'EXPENSE',
        status: 'PENDING',
        amount: '333',
        currency: 'USDT',
        senderId: ADMIN.id,
        projectId: PROJ_ID,
        createdAt: thisMonth,
        createdBy: ADMIN.id,
      },
      // SALARY PENDING → not validatable income → excluded from
      // pendingValidation AND recipientCount.
      {
        id: TX_SALARY_PENDING,
        type: 'SALARY',
        status: 'PENDING',
        amount: '444',
        currency: 'USDT',
        senderId: ADMIN.id,
        receiverId: JUNIOR.id,
        projectId: PROJ_ID,
        createdAt: thisMonth,
        createdBy: ADMIN.id,
      },
      // 2nd validatable-income row for SENIOR (already a party via the rows
      // above). VALIDATED last month so it touches NO money/count bucket; its
      // only possible effect is recipientCount — and the COUNT(DISTINCT …) must
      // dedup SENIOR to a single party (delta stays +2, not +3).
      {
        id: TX_DEDUP_PARTY,
        type: 'SENIOR_INCOME',
        status: 'VALIDATED',
        amount: '111',
        currency: 'USDT',
        senderId: SENIOR.id,
        projectId: PROJ_ID,
        validatedBy: ACCOUNTANT.id,
        validatedAt: lastMonth,
        createdAt: lastMonth,
        createdBy: SENIOR.id,
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

  // ── RBAC (AC2) ──────────────────────────────────────────────────────────────
  const forbidden: Array<[string, SessionUser]> = [
    ['SENIOR', SENIOR],
    ['JUNIOR', JUNIOR],
    ['HR', HR],
    ['DROP', DROP],
  ]
  for (const [label, persona] of forbidden) {
    it(`RBAC: ${label} → 403`, async () => {
      if (!dbAvailable) return
      const res = await app.inject({
        method: 'GET',
        url: '/api/finance/accountant-summary',
        cookies: { jwt: tokenFor(persona) },
      })
      expect(res.statusCode).toBe(403)
    })
  }

  it('RBAC: ACCOUNTANT → 200', async () => {
    if (!dbAvailable) return
    const res = await app.inject({
      method: 'GET',
      url: '/api/finance/accountant-summary',
      cookies: { jwt: tokenFor(ACCOUNTANT) },
    })
    expect(res.statusCode).toBe(200)
  })

  it('RBAC: ADMIN → 200', async () => {
    if (!dbAvailable) return
    const res = await app.inject({
      method: 'GET',
      url: '/api/finance/accountant-summary',
      cookies: { jwt: tokenFor(ADMIN) },
    })
    expect(res.statusCode).toBe(200)
  })

  // ── KPI shape + correctness (AC1) ─────────────────────────────────────────────
  it('returns a schema-valid KPI payload for ACCOUNTANT', async () => {
    if (!dbAvailable) return
    const res = await app.inject({
      method: 'GET',
      url: '/api/finance/accountant-summary',
      cookies: { jwt: tokenFor(ACCOUNTANT) },
    })
    expect(res.statusCode).toBe(200)
    // Throws if the wire shape drifts from the shared contract.
    const parsed = accountantSummarySchema.parse(res.json())
    expect(parsed).toBeTruthy()
  })

  it('KPI deltas reflect exactly this spec inserted rows (robust on seeded DB)', async () => {
    if (!dbAvailable) return
    expect(baseline).not.toBeNull()
    const base = baseline!

    const res = await app.inject({
      method: 'GET',
      url: '/api/finance/accountant-summary',
      cookies: { jwt: tokenFor(ADMIN) },
    })
    const body = accountantSummarySchema.parse(res.json())

    // Delta assertions — independent of any pre-existing seed rows. CI runs this
    // against the seeded crm_db, so absolute counts would include seed data; the
    // delta isolates exactly this spec's inserted rows. Although this spec inserts
    // 10 rows, only 5 are KPI-contributing — the other 5 (TX_PAID_OLD,
    // TX_VALIDATED_NULL, TX_EXPENSE_PENDING, TX_SALARY_PENDING, TX_DEDUP_PARTY)
    // are boundary fixtures the SQL aggregation must exclude, so the deltas below
    // are the SAME as if only those 5 contributing rows existed. The dedicated
    // boundary tests further down assert each exclusion in isolation.

    // Δ pendingValidation: +2 rows (TX_PENDING_1 1000 + TX_PENDING_2 500).
    // EXPENSE/SALARY PENDING rows excluded (not validatable income).
    expect(body.pendingValidation.count - base.pendingValidation.count).toBe(2)
    expect(
      Math.round((body.pendingValidation.amount - base.pendingValidation.amount) * 100) / 100,
    ).toBe(1500)

    // Δ validatedThisMonth: +1 (TX_VALIDATED_THIS 800); lastMonth + NULL-validatedAt
    // rows excluded.
    expect(body.validatedThisMonth.count - base.validatedThisMonth.count).toBe(1)
    expect(
      Math.round((body.validatedThisMonth.amount - base.validatedThisMonth.amount) * 100) / 100,
    ).toBe(800)

    // Δ paidThisMonth: +2000 (TX_PAID_THIS); lastMonth PAID row excluded.
    expect(Math.round((body.paidThisMonth.amount - base.paidThisMonth.amount) * 100) / 100).toBe(
      2000,
    )

    // Δ recipientCount: +2 new income parties (SENIOR + DROP — neither owned an
    // income row at baseline capture). TX_DEDUP_PARTY (2nd SENIOR income) dedups.
    expect(body.recipientCount - base.recipientCount).toBe(2)
  })

  // ── Boundary exclusions (AC6) ─────────────────────────────────────────────────
  // Each assertion is framed as a delta vs the pre-insert baseline so it holds on
  // an empty scratch DB AND on the seeded crm_db alike. The boundary fixtures were
  // inserted in beforeAll; here we prove each is correctly excluded by the SQL.

  async function summaryAsAdmin(): Promise<AccountantSummaryDtoT> {
    const res = await app.inject({
      method: 'GET',
      url: '/api/finance/accountant-summary',
      cookies: { jwt: tokenFor(ADMIN) },
    })
    return accountantSummarySchema.parse(res.json())
  }

  it('excludes PAID rows created in a previous month from paidThisMonth', async () => {
    if (!dbAvailable) return
    const base = baseline!
    const body = await summaryAsAdmin()
    // TX_PAID_OLD (6666, lastMonth) must NOT appear — only TX_PAID_THIS (2000) does.
    // If the createdAt month filter regressed, the delta would be 8666, not 2000.
    expect(Math.round((body.paidThisMonth.amount - base.paidThisMonth.amount) * 100) / 100).toBe(
      2000,
    )
  })

  it('excludes VALIDATED rows with NULL validatedAt from validatedThisMonth', async () => {
    if (!dbAvailable) return
    const base = baseline!
    const body = await summaryAsAdmin()
    // TX_VALIDATED_NULL (5555, validatedAt NULL, createdAt thisMonth) must NOT count.
    // A regressed `validated_at is not null` predicate would inflate count to 2 and
    // amount delta to 6355 (800 + 5555).
    expect(body.validatedThisMonth.count - base.validatedThisMonth.count).toBe(1)
    expect(
      Math.round((body.validatedThisMonth.amount - base.validatedThisMonth.amount) * 100) / 100,
    ).toBe(800)
  })

  it('excludes EXPENSE / SALARY rows from pendingValidation (not validatable income)', async () => {
    if (!dbAvailable) return
    const base = baseline!
    const body = await summaryAsAdmin()
    // TX_EXPENSE_PENDING (333) + TX_SALARY_PENDING (444) are PENDING but not income.
    // A regressed type filter would push count to 4 and amount delta to 2277.
    expect(body.pendingValidation.count - base.pendingValidation.count).toBe(2)
    expect(
      Math.round((body.pendingValidation.amount - base.pendingValidation.amount) * 100) / 100,
    ).toBe(1500)
  })

  it('dedups a party with multiple income rows in recipientCount (COUNT DISTINCT)', async () => {
    if (!dbAvailable) return
    const base = baseline!
    const body = await summaryAsAdmin()
    // SENIOR owns TX_PENDING_1, TX_VALIDATED_THIS, TX_PAID_THIS, TX_PAID_OLD,
    // TX_VALIDATED_NULL AND TX_DEDUP_PARTY — six income rows, ONE distinct party.
    // DROP owns one. So the distinct-party delta is exactly +2, never per-row.
    expect(body.recipientCount - base.recipientCount).toBe(2)
  })

  it('never leaks NULL through COALESCE — amounts are always finite numbers', async () => {
    if (!dbAvailable) return
    const body = await summaryAsAdmin()
    // COALESCE(SUM(...), 0) guarantees the empty-set / no-match buckets are 0, never
    // NULL/NaN. (The empty-DB → all-zeros path is proven in the unit spec; here we
    // assert the wire payload always carries finite numeric money on a real DB.)
    for (const amount of [
      body.pendingValidation.amount,
      body.validatedThisMonth.amount,
      body.paidThisMonth.amount,
    ]) {
      expect(Number.isFinite(amount)).toBe(true)
    }
    expect(Number.isInteger(body.pendingValidation.count)).toBe(true)
    expect(Number.isInteger(body.validatedThisMonth.count)).toBe(true)
    expect(Number.isInteger(body.recipientCount)).toBe(true)
  })
})
