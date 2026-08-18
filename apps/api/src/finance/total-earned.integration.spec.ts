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
import { hasDatabaseUrl } from '../test/require-real-db'

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
 * DB-SKIP-GUARD:
 *   describe.skipIf(!hasDatabaseUrl()) when DATABASE_URL is unset (reports
 *   SKIPPED). A DATABASE_URL that IS set but unusable throws in beforeAll
 *   (reports FAILED). Neither case can look like "passed" with zero assertions.
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
// C-1 (mega-audit wave 2): a self-referential PAYOUT_DROP (senderId ===
// receiverId === DROP.id — the owner's ruling: bad/legacy data, not a real
// flow) must NOT double-credit the drop's payout bucket. It nets to zero,
// mirroring computeDropAggregate's `received − sent` (transactions.service
// .ts).
//
// task-sender-receiver-invariant (backlog A-2, 2026-08-18): this id is kept
// (harmless in the cleanup delete-by-id list below) but the row is NO LONGER
// seeded — `ck_transactions_sender_ne_receiver` now rejects it at the DB, the
// same "bad/legacy data" this comment already called it out as. See the
// skipped C-1 test further down for the full reasoning.
const TX_DROP_PAYOUT_SELF_REF = 'fe111111-0000-4000-cc00-00000000000b' // PAYOUT_DROP PAID 333.33 sender=receiver=drop — NO LONGER SEEDED (see above)
// Audit 2026-06-28 (#2): a gross DROP_INCOME (senderId=null, external client) is
// NO LONGER counted toward totalEarned — its real slice is the linked PAYOUT_DROP,
// so counting both double-counts. Kept in the fixture to prove it is excluded.
const TX_DROP_INCOME_GROSS = 'fe111111-0000-4000-cc00-000000000008' // DROP_INCOME PAID 250 senderId=null → EXCLUDED
const TX_DROP_INCOME_PENDING = 'fe111111-0000-4000-cc00-000000000009' // DROP_INCOME PENDING 999 → excluded
// A DIRECT admin→drop DROP_INCOME (senderId set, no PAYOUT_DROP slice) — Сергей's
// GamingTec-style comp. This one IS still counted (its income would otherwise be lost).
const TX_DROP_INCOME_DIRECT = 'fe111111-0000-4000-cc00-00000000000a' // DROP_INCOME PAID 400 senderId=admin → COUNTED

const TEST_USER_IDS = [ACCOUNTANT.id, ADMIN.id, SENIOR.id, JUNIOR.id, HR.id, DROP.id]
const TEST_TX_IDS = [
  TX_JUNIOR_SALARY_PAID,
  TX_JUNIOR_SALARY_PAID_2,
  TX_JUNIOR_SALARY_PENDING,
  TX_HR_SALARY_PAID,
  TX_SENIOR_INCOME_PAID,
  TX_SENIOR_INCOME_VALIDATED,
  TX_DROP_PAYOUT_PAID,
  TX_DROP_PAYOUT_SELF_REF,
  TX_DROP_INCOME_GROSS,
  TX_DROP_INCOME_PENDING,
  TX_DROP_INCOME_DIRECT,
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
describe.skipIf(!hasDatabaseUrl())(
  'total-earned — real backend integration (real DB, no mocks)',
  () => {
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
          throw new Error('[total-earned integration] FAILED — transactions table not found')
        }
      } catch {
        throw new Error(
          '[total-earned integration] FAILED — no DB reachable at DATABASE_URL (expected in CI unit job)',
        )
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
      // DROP earned = 1500 (PAYOUT_DROP PAID) + 400 (DIRECT DROP_INCOME, senderId set)
      //   = 1900. The GROSS DROP_INCOME (250, senderId=null) is EXCLUDED (audit #2 —
      //   its slice is the PAYOUT_DROP); the PENDING drop income is excluded too.
      //   The self-referential PAYOUT_DROP (333.33, C-1) is NO LONGER seeded
      //   (task-sender-receiver-invariant, 2026-08-18 — see TX_DROP_PAYOUT_SELF_REF
      //   above and the skipped C-1 test below), so it does not appear in this total.
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
        // task-sender-receiver-invariant (backlog A-2, 2026-08-18): the
        // TX_DROP_PAYOUT_SELF_REF fixture (senderId === receiverId === DROP.id)
        // used to be seeded here. It can no longer be inserted at all — the new
        // `ck_transactions_sender_ne_receiver` DB CHECK on `transactions` rejects
        // ANY row where both sides are non-null and equal, through every write
        // path including a raw test-fixture insert like this one. See the
        // skipped C-1 test below for the full story (why the row existed, why
        // removing the constraint is not the fix).
        {
          // GROSS DROP_INCOME — senderId=null (external client). EXCLUDED by #2.
          id: TX_DROP_INCOME_GROSS,
          type: 'DROP_INCOME',
          status: 'PAID',
          amount: '250',
          currency: 'USD',
          senderId: null,
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
        {
          // DIRECT admin→drop DROP_INCOME — senderId set, no PAYOUT_DROP slice. COUNTED.
          id: TX_DROP_INCOME_DIRECT,
          type: 'DROP_INCOME',
          status: 'PAID',
          amount: '400',
          currency: 'USD',
          senderId: ADMIN.id,
          receiverId: DROP.id,
          recipientId: DROP.id,
          projectId: PROJ_ID,
          createdBy: ADMIN.id,
        },
      ])
    }, 30_000)

    afterAll(async () => {
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
        // Even self-view is forbidden for non-privileged roles.
        const res = await earnedFor(persona, persona.id)
        expect(res.statusCode).toBe(403)
      })
    }

    it('RBAC: ACCOUNTANT → 200', async () => {
      const res = await earnedFor(ACCOUNTANT, JUNIOR.id)
      expect(res.statusCode).toBe(200)
    })

    it('RBAC: ADMIN → 200', async () => {
      const res = await earnedFor(ADMIN, JUNIOR.id)
      expect(res.statusCode).toBe(200)
    })

    // ── Schema shape (AC) ───────────────────────────────────────────────────────
    it('returns a schema-valid TotalEarnedDto', async () => {
      const res = await earnedFor(ACCOUNTANT, JUNIOR.id)
      const parsed: TotalEarnedDto = totalEarnedSchema.parse(res.json())
      expect(parsed.userId).toBe(JUNIOR.id)
      expect(parsed.role).toBe('JUNIOR')
      expect(parsed.currency).toBe('USD')
    })

    // ── Correctness per role (AC4) ──────────────────────────────────────────────
    it('JUNIOR totalEarned = sum of PAID SALARY (excludes PENDING)', async () => {
      const body = totalEarnedSchema.parse((await earnedFor(ADMIN, JUNIOR.id)).json())
      // 1000 + 500 PAID; 777 PENDING excluded.
      expect(Math.round(body.totalEarned * 100) / 100).toBe(1500)
      expect(Math.round((body.breakdown['salary'] ?? 0) * 100) / 100).toBe(1500)
    })

    it('HR totalEarned = sum of PAID SALARY', async () => {
      const body = totalEarnedSchema.parse((await earnedFor(ACCOUNTANT, HR.id)).json())
      expect(Math.round(body.totalEarned * 100) / 100).toBe(2000)
    })

    it('SENIOR totalEarned = PAID SENIOR_INCOME (excludes non-PAID)', async () => {
      const body = totalEarnedSchema.parse((await earnedFor(ADMIN, SENIOR.id)).json())
      // 3000 PAID; 4444 VALIDATED excluded.
      expect(Math.round(body.totalEarned * 100) / 100).toBe(3000)
      expect(Math.round((body.breakdown['income'] ?? 0) * 100) / 100).toBe(3000)
    })

    it('DROP totalEarned = PAID PAYOUT_DROP + DIRECT DROP_INCOME (excludes gross + PENDING) (#2)', async () => {
      const body = totalEarnedSchema.parse((await earnedFor(ACCOUNTANT, DROP.id)).json())
      // 1500 PAYOUT_DROP + 400 DIRECT DROP_INCOME (senderId set). The 250 GROSS
      // DROP_INCOME (senderId=null) is excluded by #2 (its slice IS the PAYOUT_DROP),
      // and the 999 PENDING is excluded. Total = 1900.
      expect(Math.round(body.totalEarned * 100) / 100).toBe(1900)
      expect(Math.round((body.breakdown['payout'] ?? 0) * 100) / 100).toBe(1500)
      // Only the DIRECT income (400) lands in the income bucket — NOT the 250 gross.
      expect(Math.round((body.breakdown['income'] ?? 0) * 100) / 100).toBe(400)
    })

    // C-1 (mega-audit wave 2), real backend + real Postgres: the self-referential
    // PAYOUT_DROP fixture (TX_DROP_PAYOUT_SELF_REF, senderId===receiverId===DROP)
    // must not move the payout bucket. RED before the C-1 fix (would have added
    // 333.33 → payout=1833.33, totalEarned=2233.33); GREEN after (payout=1500,
    // totalEarned=1900 — identical to the test above, proving the self-ref row
    // is a true no-op end-to-end, through the real HTTP route + real DB).
    //
    // SKIPPED task-sender-receiver-invariant (backlog A-2, 2026-08-18): the
    // fixture this test depends on can no longer be created at all — the new
    // `ck_transactions_sender_ne_receiver` DB CHECK on `transactions` rejects
    // ANY insert with senderId === receiverId (both non-null), through every
    // write path including this raw test-fixture insert (verified: running
    // this file's `beforeAll` against a DB carrying the constraint throws
    // Postgres 23514 on exactly this row). Per that task's AC6 ("если
    // что-то упало — это находка, а не повод ослабить ограничение"), the fix
    // is here, not a weaker constraint. The DEFENSIVE code this test exercised
    // (computeDropAggregate's `received − sent`, which nets a self-loop to
    // zero) is UNCHANGED and stays as belt-and-suspenders — the DB now backs
    // it up structurally instead of relying on it alone. Un-skippable without
    // either a new low-level unit test against a mocked query result (no real
    // insert) or a deliberate, scoped constraint-drop-then-restore inside the
    // test itself — both out of scope for the invariant task.
    it.skip('DROP self-referential PAYOUT_DROP (senderId===receiverId===drop) nets to zero (C-1)', async () => {
      const body = totalEarnedSchema.parse((await earnedFor(ACCOUNTANT, DROP.id)).json())
      expect(Math.round((body.breakdown['payout'] ?? 0) * 100) / 100).toBe(1500)
      expect(Math.round(body.totalEarned * 100) / 100).toBe(1900)
    })

    it('amounts are always finite numbers (no NULL/NaN leak)', async () => {
      const body = totalEarnedSchema.parse((await earnedFor(ADMIN, SENIOR.id)).json())
      expect(Number.isFinite(body.totalEarned)).toBe(true)
      for (const v of Object.values(body.breakdown)) {
        expect(Number.isFinite(v)).toBe(true)
      }
    })
  },
)
