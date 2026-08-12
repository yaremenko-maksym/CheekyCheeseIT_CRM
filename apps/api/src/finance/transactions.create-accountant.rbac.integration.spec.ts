import { Body, Controller, Global, Inject, Module, Post } from '@nestjs/common'
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
import {
  createAdminIncomeSchema,
  createAdminTransferSchema,
  createExpenseSchema,
  createSalarySchema,
} from '@crm/shared'

import { JwtAuthGuard } from '../auth/jwt.guard'
import { CurrentUser } from '../auth/current-user.decorator'
import { DatabaseService } from '../database/database.service'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'
import { TransactionsService } from './transactions.service'
import type { InvoicesService } from '../invoices/invoices.service'
import { projects, transactions, users } from '../database/schema'
import * as schema from '../database/schema'

/**
 * task-accountant-create-transaction — real-backend RBAC integration spec
 * (real Postgres, no mocks). MANDATORY finance/RBAC coverage.
 *
 * WHY (feedback_mocked_e2e_guards, recurred 3×): mocked E2E gives false
 * confidence for endpoints behind guards. ACCOUNTANT now has create-PARITY
 * with ADMIN on the four admin-set transaction endpoints. This spec exercises
 * the REAL TransactionsService against REAL PostgreSQL through a JWT + Fastify
 * request so each role gate is proven, not stubbed:
 *
 *   POST /transactions/admin-income   — ACCOUNTANT 201, ADMIN 201, JUNIOR/HR/SENIOR/DROP 403
 *   POST /transactions/expense        — ACCOUNTANT 201, ADMIN 201, JUNIOR/HR/SENIOR/DROP 403
 *   POST /transactions/salary         — ACCOUNTANT 201, ADMIN 201, JUNIOR/HR/SENIOR/DROP 403
 *   POST /transactions/admin-transfer — ACCOUNTANT 201, ADMIN 201, JUNIOR/HR/SENIOR/DROP 403
 *
 * Parity invariants (asserted on the persisted rows):
 *   - ADMIN_INCOME created by ACCOUNTANT credits the admin OWNER of the project
 *     (receiverId = project.seniorId), NOT the accountant. createdBy = accountant.
 *   - ADMIN_TRANSFER created by ACCOUNTANT books a transfer between two ADMINs
 *     (accountant is never a party). createdBy = accountant.
 *
 * DB-SKIP-GUARD: dbAvailable=false when DATABASE_URL unreachable OR the
 * `transactions` table is absent → every test returns early and stays green
 * (so the CI unit job without a DB is unaffected).
 *
 * Run against a scratch DB (NEVER the live crm_db):
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_acct_create \
 *     pnpm --filter @crm/api test -- transactions.create-accountant.rbac.integration
 */

const JWT_SECRET = 'create-acct-rbac-integration-secret-32chars'

// ── Personas — stable IDs namespaced to THIS spec ───────────────────────────
const ACCOUNTANT: SessionUser = {
  id: '5acc0000-0000-4000-aa00-000000000001',
  email: 'create-acct-accountant@test.spec',
  displayName: 'Create Acct Accountant',
  avatarUrl: null,
  role: 'ACCOUNTANT',
  seniorSharePercent: 0,
  legalFullName: null,
}
const ADMIN: SessionUser = {
  id: '5acc0000-0000-4000-aa00-000000000002',
  email: 'create-acct-admin@test.spec',
  displayName: 'Create Acct Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 26,
  legalFullName: null,
}
// A second ADMIN so ADMIN_TRANSFER always has two distinct admin parties.
const ADMIN2: SessionUser = {
  id: '5acc0000-0000-4000-aa00-000000000007',
  email: 'create-acct-admin2@test.spec',
  displayName: 'Create Acct Admin Two',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 26,
  legalFullName: null,
}
const SENIOR: SessionUser = {
  id: '5acc0000-0000-4000-aa00-000000000003',
  email: 'create-acct-senior@test.spec',
  displayName: 'Create Acct Senior',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}
const JUNIOR: SessionUser = {
  id: '5acc0000-0000-4000-aa00-000000000004',
  email: 'create-acct-junior@test.spec',
  displayName: 'Create Acct Junior',
  avatarUrl: null,
  role: 'JUNIOR',
  seniorSharePercent: 0,
  legalFullName: null,
}
const HR: SessionUser = {
  id: '5acc0000-0000-4000-aa00-000000000005',
  email: 'create-acct-hr@test.spec',
  displayName: 'Create Acct HR',
  avatarUrl: null,
  role: 'HR',
  seniorSharePercent: 0,
  legalFullName: null,
}
const DROP: SessionUser = {
  id: '5acc0000-0000-4000-aa00-000000000006',
  email: 'create-acct-drop@test.spec',
  displayName: 'Create Acct Drop',
  avatarUrl: null,
  role: 'DROP',
  seniorSharePercent: 0,
  legalFullName: null,
}

const ALL_PERSONAS = [ACCOUNTANT, ADMIN, ADMIN2, SENIOR, JUNIOR, HR, DROP]
const TEST_USER_IDS = ALL_PERSONAS.map((u) => u.id)

// An admin-owned project (senior = ADMIN). ADMIN_INCOME for both ADMIN (owner)
// and ACCOUNTANT (on behalf of the owner) targets this project.
// 4th group starts with a/8/9/b so z.string().uuid() variant check passes.
const ADMIN_PROJECT_ID = '5acc0000-0000-4000-acc0-000000000001'
const TEST_PROJECT_IDS = [ADMIN_PROJECT_ID]

const FORBIDDEN: Array<[string, SessionUser]> = [
  ['SENIOR', SENIOR],
  ['JUNIOR', JUNIOR],
  ['HR', HR],
  ['DROP', DROP],
]

// ── Sentinel controller — mirrors the real /transactions create routes ──────
const TX_SERVICE = 'TX_SERVICE_CREATE_ACCT_RBAC'

@Controller('transactions')
class SentinelTransactionsController {
  constructor(@Inject(TX_SERVICE) private readonly svc: TransactionsService) {}

  @Post('admin-income')
  createAdminIncome(@Body() body: unknown, @CurrentUser() user: SessionUser) {
    return this.svc.createAdminIncome(
      createAdminIncomeSchema.parse(body) as Parameters<
        TransactionsService['createAdminIncome']
      >[0],
      user,
    )
  }

  @Post('expense')
  createExpense(@Body() body: unknown, @CurrentUser() user: SessionUser) {
    return this.svc.createExpense(
      createExpenseSchema.parse(body) as Parameters<TransactionsService['createExpense']>[0],
      user,
    )
  }

  @Post('salary')
  createSalary(@Body() body: unknown, @CurrentUser() user: SessionUser) {
    return this.svc.createSalary(
      createSalarySchema.parse(body) as Parameters<TransactionsService['createSalary']>[0],
      user,
    )
  }

  @Post('admin-transfer')
  createAdminTransfer(@Body() body: unknown, @CurrentUser() user: SessionUser) {
    return this.svc.createAdminTransfer(
      createAdminTransferSchema.parse(body) as Parameters<
        TransactionsService['createAdminTransfer']
      >[0],
      user,
    )
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

// safeAutoCreateInvoice (createSalary path) swallows invoice errors, so a stub
// InvoicesService that throws is harmless. DocumentsService is only touched for
// receipt binding, which these payloads never use.
@Module({
  imports: [
    TestDatabaseModule,
    JwtModule.register({ secret: JWT_SECRET, signOptions: { expiresIn: '1h' } }),
  ],
  controllers: [SentinelTransactionsController],
  providers: [
    Reflector,
    {
      provide: TransactionsService,
      useFactory: (db: DatabaseService) =>
        makeTransactionsService({
          db,
          invoicesService: {
            autoCreateForSalary: () => Promise.reject(new Error('stub')),
          } as unknown as InvoicesService,
        }),
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
class CreateAcctRbacTestModule {}

// ── Suite ───────────────────────────────────────────────────────────────────
describe('transactions create — ACCOUNTANT/ADMIN parity RBAC (real DB, no mocks)', () => {
  let app: NestFastifyApplication
  let jwt: JwtService
  let dbSvc: DatabaseService
  const createdTxIds: string[] = []

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
        console.warn('[create-acct-rbac integration] SKIPPED — transactions table not found')
        dbAvailable = false
        return
      }
    } catch {
      console.warn(
        '[create-acct-rbac integration] SKIPPED — no DB reachable at DATABASE_URL (expected in CI unit job)',
      )
      dbAvailable = false
      return
    }

    const moduleRef = await Test.createTestingModule({
      imports: [CreateAcctRbacTestModule],
    }).compile()

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    await app.register(cookie, { secret: 'create-acct-rbac-integration-cookie-secret' })
    app.setGlobalPrefix('api')
    await app.init()
    await app.getHttpAdapter().getInstance().ready()

    jwt = moduleRef.get(JwtService)
    dbSvc = app.get(DatabaseService)
    const db = dbSvc.db

    // Surgical cleanup of leftover rows from a previous run BEFORE seeding.
    await db
      .delete(transactions)
      .where(inArray(transactions.receiverId, [ADMIN.id, ADMIN2.id, JUNIOR.id]))
    await db
      .delete(transactions)
      .where(inArray(transactions.senderId, [ADMIN.id, ADMIN2.id, ACCOUNTANT.id]))
    await db.delete(projects).where(inArray(projects.id, TEST_PROJECT_IDS))
    await db.delete(users).where(inArray(users.id, TEST_USER_IDS))

    await db
      .insert(users)
      .values(
        ALL_PERSONAS.map((u) => ({
          id: u.id,
          email: u.email,
          displayName: u.displayName,
          role: u.role,
          googleId: `test-google-${u.id}`,
        })),
      )
      .onConflictDoNothing()

    // Admin-owned project (senior = ADMIN). Used by both ADMIN_INCOME cases.
    await db
      .insert(projects)
      .values({
        id: ADMIN_PROJECT_ID,
        name: 'Create Acct Admin Project',
        companyName: 'Acct Income Corp',
        domain: 'ai',
        startDate: new Date('2025-01-01'),
        seniorId: ADMIN.id,
        currency: 'USDT',
        rate: 1000,
      })
      .onConflictDoNothing()
  }, 30_000)

  afterAll(async () => {
    if (!dbAvailable) return
    try {
      const db = dbSvc.db
      if (createdTxIds.length) {
        await db.delete(transactions).where(inArray(transactions.id, createdTxIds))
      }
      await db.delete(projects).where(inArray(projects.id, TEST_PROJECT_IDS))
      await db.delete(users).where(inArray(users.id, TEST_USER_IDS))
    } catch {
      // non-fatal
    }
    await app.close()
  }, 15_000)

  function tokenFor(user: SessionUser): string {
    return jwt.sign(user)
  }

  async function post(
    url: string,
    user: SessionUser,
    payload: Record<string, unknown>,
  ): Promise<{ status: number; json: unknown }> {
    const res = await app.inject({
      method: 'POST',
      url,
      cookies: { jwt: tokenFor(user) },
      payload,
    })
    let json: unknown = null
    try {
      json = res.json()
    } catch {
      json = null
    }
    // Track created rows for surgical cleanup.
    if (res.statusCode === 201 && json && typeof json === 'object' && 'id' in json) {
      createdTxIds.push((json as { id: string }).id)
    }
    return { status: res.statusCode, json }
  }

  // task-receipts-backend (review round 1): receipt is now MANDATORY on these
  // create endpoints (currency='USDT' → explorer-only, MED-2 defense-in-depth).
  // This spec is pure RBAC (who can call the endpoint) — a fixed valid explorer
  // receipt keeps every role assertion (201/403) deterministic and unrelated to
  // the receipt gate itself (covered by finance.receipts.spec.ts).
  const RECEIPT = { receiptExternalUrl: 'https://etherscan.io/tx/0xcreateacctrbacspec' }

  // Payload builders — minimal valid bodies per endpoint.
  const adminIncomePayload = () => ({
    projectId: ADMIN_PROJECT_ID,
    amount: 1000,
    currency: 'USDT',
    ...RECEIPT,
  })
  const expensePayload = () => ({
    amount: 50,
    currency: 'USDT',
    category: 'Прочее',
    ...RECEIPT,
  })
  // task-salary-pay-flow: this spec is pure RBAC (who can call the endpoint).
  // createSalary now creates a NEUTRAL PENDING reminder — no funding source, no
  // balance gate at creation — so the role assertions (201/403) are deterministic
  // regardless of the company-account balance. No funding fields needed here.
  // Audit 2026-06-27 (LOW #5): the partial unique index
  // `uq_transactions_salary_receiver_month` now allows at most ONE SALARY per
  // (receiver, month). The two success cases (ACCOUNTANT + ADMIN) must therefore
  // target DISTINCT months — otherwise the second would correctly hit the unique
  // constraint (400). RBAC parity is unchanged: both privileged roles get 201,
  // forbidden roles get 403 (they never reach the insert, so month is irrelevant).
  const salaryPayload = (salaryMonth = '2025-03') => ({
    receiverId: JUNIOR.id,
    amount: 500,
    currency: 'USD',
    salaryMonth,
  })
  // ACCOUNTANT must pass an explicit ADMIN sender; ADMIN may omit it (defaults
  // to self). Receiver is always the other admin.
  const adminTransferPayload = (senderId?: string) => ({
    ...(senderId !== undefined ? { senderId } : {}),
    receiverId: ADMIN2.id,
    amount: 200,
    currency: 'USDT',
    ...RECEIPT,
  })

  // ── admin-income ────────────────────────────────────────────────────────────
  describe('POST /transactions/admin-income', () => {
    it('ACCOUNTANT → 201, income credited to the admin OWNER (not the accountant)', async () => {
      if (!dbAvailable) return
      const { status, json } = await post(
        '/api/transactions/admin-income',
        ACCOUNTANT,
        adminIncomePayload(),
      )
      expect(status).toBe(201)
      const tx = json as { id: string; type: string }
      expect(tx.type).toBe('ADMIN_INCOME')
      // Verify the persisted row credits the admin owner + records the accountant.
      const row = await dbSvc.db.query.transactions.findFirst({
        where: (t, { eq }) => eq(t.id, tx.id),
      })
      expect(row?.receiverId).toBe(ADMIN.id)
      expect(row?.createdBy).toBe(ACCOUNTANT.id)
    })

    it('ADMIN → 201 (regression, credited to self)', async () => {
      if (!dbAvailable) return
      const { status, json } = await post(
        '/api/transactions/admin-income',
        ADMIN,
        adminIncomePayload(),
      )
      expect(status).toBe(201)
      const row = await dbSvc.db.query.transactions.findFirst({
        where: (t, { eq }) => eq(t.id, (json as { id: string }).id),
      })
      expect(row?.receiverId).toBe(ADMIN.id)
    })

    // task-admin-income-unified (§2, owner decision 2026-08-12). ADMIN may now
    // pick a DIFFERENT active admin as the receiver — the same "who gets
    // credited" freedom `declareUsdtProjectIncome` already had, extended to
    // this non-USDT path (see the schema/service doc comments).
    it('ADMIN with an explicit receiverId → 201, credits THAT admin (not self)', async () => {
      if (!dbAvailable) return
      const { status, json } = await post('/api/transactions/admin-income', ADMIN, {
        ...adminIncomePayload(),
        receiverId: ADMIN2.id,
      })
      expect(status).toBe(201)
      const row = await dbSvc.db.query.transactions.findFirst({
        where: (t, { eq }) => eq(t.id, (json as { id: string }).id),
      })
      expect(row?.receiverId).toBe(ADMIN2.id)
      expect(row?.createdBy).toBe(ADMIN.id)
    })

    // AC10: the accountant has never been a router of funds — the server
    // hard-credits the project's admin owner for this role. A payload that
    // disagrees (an explicit receiverId, even the caller's own admin-owner
    // target) is a contract violation, not a preference to honour — the web
    // dialog's selector never offers this choice for ACCOUNTANT either.
    it('ACCOUNTANT with an explicit receiverId → 403 (no routing freedom, AC10)', async () => {
      if (!dbAvailable) return
      const { status } = await post('/api/transactions/admin-income', ACCOUNTANT, {
        ...adminIncomePayload(),
        receiverId: ADMIN.id,
      })
      expect(status).toBe(403)
    })

    // The COMPANY_ACCOUNT sentinel is NOT "picking a specific admin" — it
    // stays available to the accountant (unchanged capability, just expressed
    // through the new field name).
    it('ACCOUNTANT with receiverId=COMPANY_ACCOUNT → 201 (still allowed — not a specific-admin choice)', async () => {
      if (!dbAvailable) return
      const { status, json } = await post('/api/transactions/admin-income', ACCOUNTANT, {
        ...adminIncomePayload(),
        receiverId: 'COMPANY_ACCOUNT',
      })
      expect(status).toBe(201)
      const row = await dbSvc.db.query.transactions.findFirst({
        where: (t, { eq }) => eq(t.id, (json as { id: string }).id),
      })
      expect(row?.fundingSource).toBe('COMPANY_ACCOUNT')
      expect(row?.receiverId).toBe(ACCOUNTANT.id)
    })

    for (const [label, persona] of FORBIDDEN) {
      it(`${label} → 403`, async () => {
        if (!dbAvailable) return
        const { status } = await post(
          '/api/transactions/admin-income',
          persona,
          adminIncomePayload(),
        )
        expect(status).toBe(403)
      })
    }
  })

  // ── expense ───────────────────────────────────────────────────────────────
  describe('POST /transactions/expense', () => {
    it('ACCOUNTANT → 201', async () => {
      if (!dbAvailable) return
      const { status, json } = await post('/api/transactions/expense', ACCOUNTANT, expensePayload())
      expect(status).toBe(201)
      expect((json as { type: string }).type).toBe('EXPENSE')
    })

    it('ADMIN → 201 (regression)', async () => {
      if (!dbAvailable) return
      const { status } = await post('/api/transactions/expense', ADMIN, expensePayload())
      expect(status).toBe(201)
    })

    for (const [label, persona] of FORBIDDEN) {
      it(`${label} → 403`, async () => {
        if (!dbAvailable) return
        const { status } = await post('/api/transactions/expense', persona, expensePayload())
        expect(status).toBe(403)
      })
    }
  })

  // ── salary ──────────────────────────────────────────────────────────────────
  describe('POST /transactions/salary', () => {
    it('ACCOUNTANT → 201', async () => {
      if (!dbAvailable) return
      // Distinct month from the ADMIN case so both 201 under the (receiver,month)
      // unique index (audit #5). '2025-03' window namespaced to ACCOUNTANT.
      const { status, json } = await post(
        '/api/transactions/salary',
        ACCOUNTANT,
        salaryPayload('2025-03'),
      )
      expect(status).toBe(201)
      expect((json as { type: string }).type).toBe('SALARY')
    })

    it('ADMIN → 201 (regression)', async () => {
      if (!dbAvailable) return
      // Distinct month from the ACCOUNTANT case (unique index, audit #5).
      const { status } = await post('/api/transactions/salary', ADMIN, salaryPayload('2025-04'))
      expect(status).toBe(201)
    })

    it('duplicate (receiver, month) → 400 (unique index, audit #5)', async () => {
      if (!dbAvailable) return
      // First create for a fresh month succeeds; a second create for the SAME
      // (receiver, month) is rejected with a clean 400 (not a raw 500).
      const dupMonth = '2025-05'
      const first = await post('/api/transactions/salary', ADMIN, salaryPayload(dupMonth))
      expect(first.status).toBe(201)
      const second = await post('/api/transactions/salary', ADMIN, salaryPayload(dupMonth))
      expect(second.status).toBe(400)
    })

    for (const [label, persona] of FORBIDDEN) {
      it(`${label} → 403`, async () => {
        if (!dbAvailable) return
        const { status } = await post('/api/transactions/salary', persona, salaryPayload())
        expect(status).toBe(403)
      })
    }
  })

  // ── admin-transfer ──────────────────────────────────────────────────────────
  describe('POST /transactions/admin-transfer', () => {
    it('ACCOUNTANT → 201, transfer is between two ADMINs (accountant not a party)', async () => {
      if (!dbAvailable) return
      const { status, json } = await post(
        '/api/transactions/admin-transfer',
        ACCOUNTANT,
        adminTransferPayload(ADMIN.id),
      )
      expect(status).toBe(201)
      const tx = json as { id: string; type: string }
      expect(tx.type).toBe('ADMIN_TRANSFER')
      const row = await dbSvc.db.query.transactions.findFirst({
        where: (t, { eq }) => eq(t.id, tx.id),
      })
      expect(row?.senderId).toBe(ADMIN.id)
      expect(row?.receiverId).toBe(ADMIN2.id)
      expect(row?.createdBy).toBe(ACCOUNTANT.id)
    })

    it('ACCOUNTANT without an ADMIN sender → 400 (accountant is never a transfer party)', async () => {
      if (!dbAvailable) return
      // Omitting senderId must NOT implicitly make the accountant the sender.
      const { status } = await post(
        '/api/transactions/admin-transfer',
        ACCOUNTANT,
        adminTransferPayload(),
      )
      expect(status).toBe(400)
    })

    it('ADMIN → 201 (regression, self as sender)', async () => {
      if (!dbAvailable) return
      const { status, json } = await post(
        '/api/transactions/admin-transfer',
        ADMIN,
        adminTransferPayload(),
      )
      expect(status).toBe(201)
      const row = await dbSvc.db.query.transactions.findFirst({
        where: (t, { eq }) => eq(t.id, (json as { id: string }).id),
      })
      expect(row?.senderId).toBe(ADMIN.id)
      expect(row?.receiverId).toBe(ADMIN2.id)
    })

    for (const [label, persona] of FORBIDDEN) {
      it(`${label} → 403`, async () => {
        if (!dbAvailable) return
        const { status } = await post(
          '/api/transactions/admin-transfer',
          persona,
          adminTransferPayload(ADMIN.id),
        )
        expect(status).toBe(403)
      })
    }
  })
})
