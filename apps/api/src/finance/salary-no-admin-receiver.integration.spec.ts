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
import { createSalarySchema } from '@crm/shared'

import { JwtAuthGuard } from '../auth/jwt.guard'
import { CurrentUser } from '../auth/current-user.decorator'
import { DatabaseService } from '../database/database.service'
import { TransactionsService } from './transactions.service'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'
import type { InvoicesService } from '../invoices/invoices.service'
import { transactions, users } from '../database/schema'
import * as schema from '../database/schema'

/**
 * task-salary-no-admin-receiver (security-MED #222) — real-DB integration spec.
 *
 * Business rule: ADMIN cannot receive SALARY. Income via admin shares only.
 * ACCOUNTANT self-pay ALLOWED (nalymed employee).
 *
 * Guards tested:
 *   POST /transactions/salary  receiver=ADMIN      → 400 BadRequest
 *   POST /transactions/salary  receiver=ACCOUNTANT → 201 OK  (incl. self)
 *   POST /transactions/salary  receiver=SENIOR     → 201 OK
 *   POST /transactions/salary  receiver=JUNIOR     → 201 OK (regression)
 *   POST /transactions/salary  receiver=HR         → 201 OK (regression)
 *   POST /transactions/salary  receiver=DROP       → 201 OK
 *
 * DB-SKIP-GUARD: dbAvailable=false when DATABASE_URL unreachable or
 * `transactions` table absent → all tests skip gracefully (CI unit job).
 *
 * Run against scratch DB (NEVER the live crm_db):
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_qa \
 *     pnpm --filter @crm/api test -- salary-no-admin-receiver.integration
 */

const JWT_SECRET = 'salary-no-admin-receiver-integration-secret-32ch'

// ── Personas — stable IDs namespaced to THIS spec ────────────────────────────
// Prefix 5nar to avoid collision with other specs.
const ADMIN_CALLER: SessionUser = {
  id: '5a110000-0000-4000-aa00-000000000001',
  email: 'nar-admin-caller@test.spec',
  displayName: 'NAR Admin Caller',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 26,
  legalFullName: null,
}
const ADMIN_RECEIVER: SessionUser = {
  id: '5a110000-0000-4000-aa00-000000000002',
  email: 'nar-admin-receiver@test.spec',
  displayName: 'NAR Admin Receiver',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 26,
  legalFullName: null,
}
const ACCOUNTANT: SessionUser = {
  id: '5a110000-0000-4000-aa00-000000000003',
  email: 'nar-accountant@test.spec',
  displayName: 'NAR Accountant',
  avatarUrl: null,
  role: 'ACCOUNTANT',
  seniorSharePercent: 0,
  legalFullName: null,
}
const SENIOR_RECEIVER: SessionUser = {
  id: '5a110000-0000-4000-aa00-000000000004',
  email: 'nar-senior@test.spec',
  displayName: 'NAR Senior',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}
const JUNIOR_RECEIVER: SessionUser = {
  id: '5a110000-0000-4000-aa00-000000000005',
  email: 'nar-junior@test.spec',
  displayName: 'NAR Junior',
  avatarUrl: null,
  role: 'JUNIOR',
  seniorSharePercent: 0,
  legalFullName: null,
}
const HR_RECEIVER: SessionUser = {
  id: '5a110000-0000-4000-aa00-000000000006',
  email: 'nar-hr@test.spec',
  displayName: 'NAR HR',
  avatarUrl: null,
  role: 'HR',
  seniorSharePercent: 0,
  legalFullName: null,
}
const DROP_RECEIVER: SessionUser = {
  id: '5a110000-0000-4000-aa00-000000000007',
  email: 'nar-drop@test.spec',
  displayName: 'NAR Drop',
  avatarUrl: null,
  role: 'DROP',
  seniorSharePercent: 0,
  legalFullName: null,
}

const ALL_PERSONAS = [
  ADMIN_CALLER,
  ADMIN_RECEIVER,
  ACCOUNTANT,
  SENIOR_RECEIVER,
  JUNIOR_RECEIVER,
  HR_RECEIVER,
  DROP_RECEIVER,
]
const TEST_USER_IDS = ALL_PERSONAS.map((u) => u.id)

// task-salary-pay-flow: createSalary now creates a NEUTRAL PENDING reminder —
// it no longer picks a funding source and is NOT gated by the company balance
// (funding is chosen at pay time). This spec asserts the RECEIVER-ROLE guard
// only; the deposit below is now harmless residual (kept for cleanup symmetry —
// createSalary no longer reads it). Namespaced id so cleanup is deterministic.
const NAR_DEPOSIT_ID = '5a110000-0000-4000-cc00-000000000001'

// ── Sentinel controller ────────────────────────────────────────────────────────
const TX_SERVICE = 'TX_SERVICE_NAR_INTEGRATION'

@Controller('transactions')
class SentinelTransactionsController {
  constructor(@Inject(TX_SERVICE) private readonly svc: TransactionsService) {}

  @Post('salary')
  createSalary(@Body() body: unknown, @CurrentUser() user: SessionUser) {
    return this.svc.createSalary(
      createSalarySchema.parse(body) as Parameters<TransactionsService['createSalary']>[0],
      user,
    )
  }
}

// ── TestDatabaseModule ─────────────────────────────────────────────────────────
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
  controllers: [SentinelTransactionsController],
  providers: [
    Reflector,
    {
      provide: TransactionsService,
      useFactory: (db: DatabaseService) =>
        makeTransactionsService({
          db,
          // safeAutoCreateInvoice swallows errors, so a stub that throws is safe.
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
class NarTestModule {}

// ── Suite ──────────────────────────────────────────────────────────────────────
describe('createSalary — ADMIN receiver guard (real DB, no mocks)', () => {
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
        console.warn('[nar integration] SKIPPED — transactions table not found')
        dbAvailable = false
        return
      }
    } catch {
      console.warn(
        '[nar integration] SKIPPED — no DB reachable at DATABASE_URL (expected in CI unit job)',
      )
      dbAvailable = false
      return
    }

    const moduleRef = await Test.createTestingModule({
      imports: [NarTestModule],
    }).compile()

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    await app.register(cookie, { secret: 'nar-integration-cookie-secret-32chars' })
    app.setGlobalPrefix('api')
    await app.init()
    await app.getHttpAdapter().getInstance().ready()

    jwt = moduleRef.get(JwtService)
    dbSvc = app.get(DatabaseService)
    const db = dbSvc.db

    // Surgical cleanup before seeding.
    await db.delete(transactions).where(inArray(transactions.receiverId, TEST_USER_IDS))
    await db.delete(transactions).where(inArray(transactions.senderId, TEST_USER_IDS))
    await db.delete(transactions).where(inArray(transactions.id, [NAR_DEPOSIT_ID]))
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

    // task-salary-company-account: large company deposit so company-funded
    // salaries (the new default) pass the balance gate. The salary amounts in
    // this suite total well under 1e6.
    await db.insert(transactions).values({
      id: NAR_DEPOSIT_ID,
      type: 'COMPANY_DEPOSIT',
      status: 'PAID',
      amount: '1000000',
      currency: 'USDT',
      senderId: SENIOR_RECEIVER.id,
      createdBy: ADMIN_CALLER.id,
    })
  }, 30_000)

  afterAll(async () => {
    if (!dbAvailable) return
    try {
      const db = dbSvc.db
      if (createdTxIds.length) {
        await db.delete(transactions).where(inArray(transactions.id, createdTxIds))
      }
      await db.delete(transactions).where(inArray(transactions.id, [NAR_DEPOSIT_ID]))
      await db.delete(users).where(inArray(users.id, TEST_USER_IDS))
    } catch {
      // non-fatal cleanup
    }
    await app.close()
  }, 15_000)

  function tokenFor(user: SessionUser): string {
    return jwt.sign(user)
  }

  async function postSalary(
    caller: SessionUser,
    payload: Record<string, unknown>,
  ): Promise<{ status: number; json: unknown }> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/transactions/salary',
      cookies: { jwt: tokenFor(caller) },
      payload,
    })
    let json: unknown = null
    try {
      json = res.json()
    } catch {
      json = null
    }
    if (res.statusCode === 201 && json && typeof json === 'object' && 'id' in json) {
      createdTxIds.push((json as { id: string }).id)
    }
    return { status: res.statusCode, json }
  }

  // ── ADMIN receiver → must be rejected ───────────────────────────────────────
  describe('receiver = ADMIN', () => {
    it('ADMIN caller + ADMIN receiver → 400 (ADMIN не отримує зарплату)', async () => {
      if (!dbAvailable) return
      const { status, json } = await postSalary(ADMIN_CALLER, {
        receiverId: ADMIN_RECEIVER.id,
        amount: 1000,
        currency: 'USD',
        salaryMonth: '2025-06',
      })
      expect(status).toBe(400)
      expect(JSON.stringify(json)).toContain('ADMIN')
    })

    it('ACCOUNTANT caller + ADMIN receiver → 400', async () => {
      if (!dbAvailable) return
      const { status } = await postSalary(ACCOUNTANT, {
        receiverId: ADMIN_RECEIVER.id,
        amount: 1000,
        currency: 'USD',
        salaryMonth: '2025-06',
      })
      expect(status).toBe(400)
    })
  })

  // ── Allowed receivers → 201 ──────────────────────────────────────────────────
  describe('receiver = ACCOUNTANT (incl. self-pay)', () => {
    it('ADMIN caller + ACCOUNTANT receiver → 201', async () => {
      if (!dbAvailable) return
      const { status, json } = await postSalary(ADMIN_CALLER, {
        receiverId: ACCOUNTANT.id,
        amount: 800,
        currency: 'USD',
        salaryMonth: '2025-06',
      })
      expect(status).toBe(201)
      expect((json as { type: string }).type).toBe('SALARY')
    })

    it('ACCOUNTANT self-pay → 201 (separation-of-duties NOT applied to accountant)', async () => {
      if (!dbAvailable) return
      const { status, json } = await postSalary(ACCOUNTANT, {
        receiverId: ACCOUNTANT.id,
        amount: 800,
        currency: 'USD',
        salaryMonth: '2025-07',
      })
      expect(status).toBe(201)
      expect((json as { type: string }).type).toBe('SALARY')
    })
  })

  describe('receiver = SENIOR', () => {
    it('ADMIN caller + SENIOR receiver → 201', async () => {
      if (!dbAvailable) return
      const { status, json } = await postSalary(ADMIN_CALLER, {
        receiverId: SENIOR_RECEIVER.id,
        amount: 1200,
        currency: 'USD',
        salaryMonth: '2025-06',
      })
      expect(status).toBe(201)
      expect((json as { type: string }).type).toBe('SALARY')
    })
  })

  describe('receiver = JUNIOR (regression)', () => {
    it('ADMIN caller + JUNIOR receiver → 201', async () => {
      if (!dbAvailable) return
      const { status, json } = await postSalary(ADMIN_CALLER, {
        receiverId: JUNIOR_RECEIVER.id,
        amount: 600,
        currency: 'USD',
        salaryMonth: '2025-06',
      })
      expect(status).toBe(201)
      expect((json as { type: string }).type).toBe('SALARY')
    })
  })

  describe('receiver = HR (regression)', () => {
    it('ADMIN caller + HR receiver → 201', async () => {
      if (!dbAvailable) return
      const { status, json } = await postSalary(ADMIN_CALLER, {
        receiverId: HR_RECEIVER.id,
        amount: 700,
        currency: 'USD',
        salaryMonth: '2025-06',
      })
      expect(status).toBe(201)
      expect((json as { type: string }).type).toBe('SALARY')
    })
  })

  describe('receiver = DROP', () => {
    it('ADMIN caller + DROP receiver → 201', async () => {
      if (!dbAvailable) return
      const { status, json } = await postSalary(ADMIN_CALLER, {
        receiverId: DROP_RECEIVER.id,
        amount: 500,
        currency: 'USD',
        salaryMonth: '2025-06',
      })
      expect(status).toBe(201)
      expect((json as { type: string }).type).toBe('SALARY')
    })
  })

  // ── Caller RBAC gate — only ADMIN/ACCOUNTANT may create salary ───────────────
  // code LOW (review MED#1 followup): verify non-privileged callers (SENIOR, JUNIOR, HR)
  // are blocked at the caller-role guard (ForbiddenException → 403) before receiver
  // validation even runs. Ensures the caller-gate is not accidentally removed by
  // refactoring that only touches the receiver allow-list path.
  describe('caller role gate — SENIOR/JUNIOR/HR → 403', () => {
    it('SENIOR caller → 403 (caller gate, not receiver check)', async () => {
      if (!dbAvailable) return
      const { status } = await postSalary(SENIOR_RECEIVER, {
        receiverId: JUNIOR_RECEIVER.id,
        amount: 500,
        currency: 'USD',
        salaryMonth: '2025-06',
      })
      expect(status).toBe(403)
    })

    it('JUNIOR caller → 403', async () => {
      if (!dbAvailable) return
      const { status } = await postSalary(JUNIOR_RECEIVER, {
        receiverId: HR_RECEIVER.id,
        amount: 500,
        currency: 'USD',
        salaryMonth: '2025-06',
      })
      expect(status).toBe(403)
    })

    it('HR caller → 403', async () => {
      if (!dbAvailable) return
      const { status } = await postSalary(HR_RECEIVER, {
        receiverId: JUNIOR_RECEIVER.id,
        amount: 500,
        currency: 'USD',
        salaryMonth: '2025-06',
      })
      expect(status).toBe(403)
    })
  })
})
