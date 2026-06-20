import {
  Body,
  Controller,
  Get,
  Global,
  Inject,
  Module,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common'
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
import { dropIncomesQuerySchema } from '@crm/shared'

import { JwtAuthGuard } from '../auth/jwt.guard'
import { CurrentUser } from '../auth/current-user.decorator'
import { DatabaseService } from '../database/database.service'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'
import { TransactionsService } from './transactions.service'
import { PaymentChannelService } from './payment-channel.service'
import { TeamsService } from '../teams/teams.service'
import { ProjectsService } from '../projects/projects.service'
import { ProjectAuditLogService } from '../projects/project-audit-log.service'
import { HrAccessService } from '../common/hr-access.service'
import {
  payoutRequests,
  projects,
  teamMembers,
  teams,
  transactions,
  users,
} from '../database/schema'
import * as schema from '../database/schema'

/**
 * DROP RBAC — real-backend integration spec (real DB, no mocks).
 * task-drop-1-backend AC6.
 *
 * WHY (feedback_mocked_e2e_guards, recurred 3×): mocked E2E gives false
 * confidence for endpoints behind guards. This spec exercises the REAL
 * TransactionsService / PaymentChannelService / TeamsService against REAL
 * PostgreSQL so the DROP ownership SQL is actually enforced. It pins the
 * IDOR / cross-drop data-leak class that mocked tests miss.
 *
 * Matrix — drop A vs drop B (each owns their own drop-team + drop-project):
 *   - teams list:               A sees only their team; foreign team detail → 403.
 *   - GET /finance/drop/me/summary: A gets only their own; every non-DROP role → 403.
 *   - GET /transactions/:id (foreign drop's income) → 403.
 *   - POST /payments/initiate-crypto (foreign incomeId) → 403.
 *   - POST /payments/confirm-crypto  (foreign incomeId) → 403.
 *
 * DB-SKIP-GUARD: dbAvailable=false when DATABASE_URL unreachable OR the
 * `transactions` table is absent → every test returns early and stays green
 * (so the CI unit job without a DB is unaffected).
 *
 * Run against a scratch DB (NEVER the live crm_db):
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/scratch_drop1 \
 *     pnpm --filter @crm/api test -- drop.rbac
 */

const JWT_SECRET = 'drop-rbac-integration-secret-32chars0'

// ── Personas — stable IDs namespaced to THIS spec ──────────────────────────
// MAKSYM/KOSTYA are the 2 admin partners the distribution math splits across;
// they must exist for `resolveIncome` to compute partner shares.
const MAKSYM: SessionUser = {
  id: 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21',
  email: 'drop-rbac-maksym@test.spec',
  displayName: 'Maksym',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 26,
  legalFullName: null,
}
const KOSTYA: SessionUser = {
  id: 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32',
  email: 'drop-rbac-kostya@test.spec',
  displayName: 'Kostya',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 26,
  legalFullName: null,
}

const SENIOR: SessionUser = {
  id: 'd2d2e3f4-0000-4000-cc00-000000000001',
  email: 'drop-rbac-senior@test.spec',
  displayName: 'Drop RBAC Senior',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}
const JUNIOR: SessionUser = {
  id: 'd2d2e3f4-0000-4000-cc00-000000000002',
  email: 'drop-rbac-junior@test.spec',
  displayName: 'Drop RBAC Junior',
  avatarUrl: null,
  role: 'JUNIOR',
  seniorSharePercent: 0,
  legalFullName: null,
}
const HR: SessionUser = {
  id: 'd2d2e3f4-0000-4000-cc00-000000000003',
  email: 'drop-rbac-hr@test.spec',
  displayName: 'Drop RBAC HR',
  avatarUrl: null,
  role: 'HR',
  seniorSharePercent: 0,
  legalFullName: null,
}
const ACCOUNTANT: SessionUser = {
  id: 'd2d2e3f4-0000-4000-cc00-000000000004',
  email: 'drop-rbac-acc@test.spec',
  displayName: 'Drop RBAC Accountant',
  avatarUrl: null,
  role: 'ACCOUNTANT',
  seniorSharePercent: 0,
  legalFullName: null,
}
/** Drop A — the acting persona in every "own vs foreign" assertion. */
const DROP_A: SessionUser = {
  id: 'd2d2e3f4-0000-4000-cc00-00000000000a',
  email: 'drop-rbac-a@test.spec',
  displayName: 'Drop A',
  avatarUrl: null,
  role: 'DROP',
  seniorSharePercent: 0,
  legalFullName: null,
}
/** Drop B — the victim whose resources Drop A must never reach. */
const DROP_B: SessionUser = {
  id: 'd2d2e3f4-0000-4000-cc00-00000000000b',
  email: 'drop-rbac-b@test.spec',
  displayName: 'Drop B',
  avatarUrl: null,
  role: 'DROP',
  seniorSharePercent: 0,
  legalFullName: null,
}

const TEAM_A_ID = 'd2d2e3f4-0000-4000-dd00-00000000000a'
const TEAM_B_ID = 'd2d2e3f4-0000-4000-dd00-00000000000b'
const PROJ_B_ID = 'd2d2e3f4-0000-4000-ee00-00000000000b'
const PAYOUT_REQ_B_ID = 'd2d2e3f4-0000-4000-ff00-00000000000b'
const INCOME_B_ID = 'd2d2e3f4-0000-4000-ab00-00000000000b'
const PAYOUT_B_ID = 'd2d2e3f4-0000-4000-ab00-00000000000c'

// task-drop-2-backend: Drop A's OWN resources, so positive assertions
// (A sees their own incomes / projects / payments) have data to read.
const PROJ_A_ID = 'd2d2e3f4-0000-4000-ee00-00000000000a'
const INCOME_A1_ID = 'd2d2e3f4-0000-4000-ab00-00000000001a' // VALIDATED
const INCOME_A2_ID = 'd2d2e3f4-0000-4000-ab00-00000000002a' // PENDING
const PAYOUT_A_ID = 'd2d2e3f4-0000-4000-ab00-00000000003a' // PENDING_PAYMENT, sender A

// Cleanup deletes ONLY the spec-namespaced users. MAKSYM/KOSTYA are seeded
// with the canonical admin UUIDs (onConflictDoNothing keeps any pre-existing
// row) and are heavily FK-referenced by seed data — we must NOT delete them.
const TEST_USER_IDS = [SENIOR.id, JUNIOR.id, HR.id, ACCOUNTANT.id, DROP_A.id, DROP_B.id]

// ── Sentinel controllers — mirror the real routes under test ────────────────
const TX_SERVICE = 'TX_SERVICE_DROP_RBAC'
const PC_SERVICE = 'PC_SERVICE_DROP_RBAC'
const TEAMS_SERVICE = 'TEAMS_SERVICE_DROP_RBAC'
const PROJECTS_SERVICE = 'PROJECTS_SERVICE_DROP_RBAC'

@Controller('finance')
class SentinelFinanceController {
  constructor(@Inject(TX_SERVICE) private readonly svc: TransactionsService) {}

  @Get('drop/me/summary')
  dropSummary(@CurrentUser() user: SessionUser) {
    return this.svc.getDropSelfSummary(user)
  }

  // task-drop-2-backend: self-only income feed (pagination + filters).
  @Get('drop/me/incomes')
  dropIncomes(@CurrentUser() user: SessionUser, @Query() query: Record<string, string>) {
    return this.svc.getDropSelfIncomes(user, dropIncomesQuerySchema.parse(query ?? {}))
  }

  // task-drop-2-backend: self-only outgoing payments feed.
  @Get('drop/me/payments')
  dropPayments(@CurrentUser() user: SessionUser) {
    return this.svc.getDropSelfPayments(user)
  }
}

@Controller('projects')
class SentinelProjectsController {
  constructor(@Inject(PROJECTS_SERVICE) private readonly svc: ProjectsService) {}

  // task-drop-2-backend: self-only drop-project feed. Declared BEFORE the
  // param route to mirror the real controller's route-ordering (see below).
  @Get('drop/me')
  dropProjects(@CurrentUser() user: SessionUser) {
    return this.svc.findDropOwnProjects(user)
  }

  // Mirrors the real `@Get(':id')` (with the ParseUUIDPipe). Its presence makes
  // the route-ordering assertion meaningful — if `drop/me` were declared AFTER
  // this, find-my-way would route `drop` into `:id` and the pipe would 400.
  @Get(':id')
  findOne(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: SessionUser) {
    return this.svc.findOne(id, user)
  }
}

@Controller('transactions')
class SentinelTransactionsController {
  constructor(@Inject(TX_SERVICE) private readonly svc: TransactionsService) {}

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: SessionUser) {
    return this.svc.findOne(id, user)
  }
}

@Controller('payments')
class SentinelPaymentsController {
  constructor(@Inject(PC_SERVICE) private readonly svc: PaymentChannelService) {}

  @Post('initiate-crypto')
  initiate(@Body() body: { incomeId: string }, @CurrentUser() user: SessionUser) {
    return this.svc.initiateCryptoPayment(body.incomeId, user)
  }

  @Post('confirm-crypto')
  confirm(
    @Body() body: { incomeId: string; txHashes: string[] },
    @CurrentUser() user: SessionUser,
  ) {
    return this.svc.confirmCryptoPayment(body.incomeId, body.txHashes, user)
  }
}

@Controller('teams')
class SentinelTeamsController {
  constructor(@Inject(TEAMS_SERVICE) private readonly svc: TeamsService) {}

  @Get()
  findAll(@CurrentUser() user: SessionUser) {
    return this.svc.findAll(user)
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: SessionUser) {
    return this.svc.findOne(id, user)
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
  controllers: [
    SentinelFinanceController,
    SentinelTransactionsController,
    SentinelPaymentsController,
    SentinelTeamsController,
    SentinelProjectsController,
  ],
  providers: [
    Reflector,
    // TransactionsService: invoices/documents collaborators are stubbed — the
    // paths under test (findOne/getDropSelfSummary/resolveSeniorShareSnapshot)
    // never touch them (they throw 403/404 on the ownership gate first).
    {
      provide: TransactionsService,
      useFactory: (db: DatabaseService) => makeTransactionsService({ db }),
      inject: [DatabaseService],
    },
    { provide: TX_SERVICE, useExisting: TransactionsService },
    {
      provide: PaymentChannelService,
      useFactory: (db: DatabaseService, tx: TransactionsService) =>
        new PaymentChannelService(db, tx),
      inject: [DatabaseService, TransactionsService],
    },
    { provide: PC_SERVICE, useExisting: PaymentChannelService },
    // TeamsService: UsersService collaborator stubbed — findAll/findOne never
    // call back into it.
    {
      provide: TeamsService,
      useFactory: (db: DatabaseService) => new TeamsService(db, {} as never),
      inject: [DatabaseService],
    },
    { provide: TEAMS_SERVICE, useExisting: TeamsService },
    // ProjectsService: auditLog / usersService collaborators are stubbed — the
    // paths under test (findDropOwnProjects / findOne ownership gate) never call
    // back into them. hrAccess is a real instance (cheap, db-only).
    {
      provide: ProjectsService,
      useFactory: (db: DatabaseService) =>
        new ProjectsService(db, {} as ProjectAuditLogService, {} as never, new HrAccessService(db)),
      inject: [DatabaseService],
    },
    { provide: PROJECTS_SERVICE, useExisting: ProjectsService },
    {
      provide: APP_GUARD,
      useFactory: (jwtSvc: JwtService, reflector: Reflector) => new JwtAuthGuard(jwtSvc, reflector),
      inject: [JwtService, Reflector],
    },
  ],
})
class DropRbacTestModule {}

// ── Suite ───────────────────────────────────────────────────────────────────
describe('DROP RBAC — real backend integration (real DB, no mocks)', () => {
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
        console.warn('[drop-rbac integration] SKIPPED — transactions table not found')
        dbAvailable = false
        return
      }
    } catch {
      console.warn(
        '[drop-rbac integration] SKIPPED — no DB reachable at DATABASE_URL (expected in CI unit job)',
      )
      dbAvailable = false
      return
    }

    const moduleRef = await Test.createTestingModule({
      imports: [DropRbacTestModule],
    }).compile()

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    await app.register(cookie, { secret: 'drop-rbac-integration-cookie-secret' })
    app.setGlobalPrefix('api')
    await app.init()
    await app.getHttpAdapter().getInstance().ready()

    jwt = moduleRef.get(JwtService)
    dbSvc = app.get(DatabaseService)
    const db = dbSvc.db

    // ── Seed ───────────────────────────────────────────────────────────────
    await db
      .insert(users)
      .values(
        [SENIOR, JUNIOR, HR, ACCOUNTANT, DROP_A, DROP_B, MAKSYM, KOSTYA].map((u) => ({
          id: u.id,
          email: u.email,
          displayName: u.displayName,
          role: u.role,
          googleId: `test-google-${u.id}`,
        })),
      )
      .onConflictDoNothing()

    // Drop-team A: DROP_A + HR + ACCOUNTANT. Drop-team B: DROP_B + HR + ACCOUNTANT.
    await db
      .insert(teams)
      .values([
        { id: TEAM_A_ID, name: 'Команда Drop A', type: 'DROP' },
        { id: TEAM_B_ID, name: 'Команда Drop B', type: 'DROP' },
      ])
      .onConflictDoNothing()
    await db
      .insert(teamMembers)
      .values([
        { teamId: TEAM_A_ID, userId: DROP_A.id, joinedAt: new Date() },
        { teamId: TEAM_A_ID, userId: HR.id, joinedAt: new Date() },
        { teamId: TEAM_A_ID, userId: ACCOUNTANT.id, joinedAt: new Date() },
        { teamId: TEAM_B_ID, userId: DROP_B.id, joinedAt: new Date() },
        { teamId: TEAM_B_ID, userId: HR.id, joinedAt: new Date() },
        { teamId: TEAM_B_ID, userId: ACCOUNTANT.id, joinedAt: new Date() },
      ])
      .onConflictDoNothing()

    // Drop-project B (owned by DROP_B + SENIOR). Drop A must never reach it.
    await db
      .insert(projects)
      .values({
        id: PROJ_B_ID,
        name: 'Drop RBAC Project B',
        companyName: 'Victim Corp B',
        domain: 'fintech',
        startDate: new Date('2025-01-01'),
        seniorId: SENIOR.id,
        dropId: DROP_B.id,
        currency: 'USDT',
        rate: 1000,
      })
      .onConflictDoNothing()

    // A VALIDATED DROP_INCOME for project B + its placeholder PAYOUT
    // (PENDING_PAYMENT, senderId=DROP_B). This is the foreign resource Drop A
    // tries to read / pay / confirm. VALIDATED so it passes the channel gate
    // before the ownership check fires.
    await db
      .insert(payoutRequests)
      .values({
        id: PAYOUT_REQ_B_ID,
        seniorId: DROP_B.id,
        incomeAmount: '1000',
        payableAmount: '950',
        contractAddress: '0x' + 'b'.repeat(40),
        status: 'PENDING',
      })
      .onConflictDoNothing()
    await db
      .insert(transactions)
      .values([
        {
          id: INCOME_B_ID,
          type: 'DROP_INCOME',
          status: 'VALIDATED',
          amount: '1000',
          currency: 'USDT',
          senderId: null,
          senderLabel: 'Victim Corp B',
          receiverId: DROP_B.id,
          recipientId: DROP_B.id,
          projectId: PROJ_B_ID,
          payoutRequestId: PAYOUT_REQ_B_ID,
          createdBy: DROP_B.id,
        },
        {
          id: PAYOUT_B_ID,
          type: 'PAYOUT',
          status: 'PENDING_PAYMENT',
          amount: '950',
          currency: 'USDT',
          senderId: DROP_B.id,
          receiverLabel: 'CheekyCheeseIT',
          projectId: PROJ_B_ID,
          payoutRequestId: PAYOUT_REQ_B_ID,
          createdBy: DROP_B.id,
        },
      ])
      .onConflictDoNothing()

    // ── Drop A's OWN resources (task-drop-2-backend) ─────────────────────────
    // A drop-project owned by DROP_A + two DROP_INCOME rows (one VALIDATED, one
    // PENDING) + one outgoing PAYOUT (PENDING_PAYMENT, sender A). These let the
    // positive feeds assert A sees their own data while NEVER seeing B's.
    await db
      .insert(projects)
      .values({
        id: PROJ_A_ID,
        name: 'Drop RBAC Project A',
        companyName: 'TechCorp A',
        domain: 'ai',
        startDate: new Date('2025-02-01'),
        seniorId: SENIOR.id,
        dropId: DROP_A.id,
        currency: 'USDT',
        rate: 1000,
      })
      .onConflictDoNothing()
    await db
      .insert(transactions)
      .values([
        {
          id: INCOME_A1_ID,
          type: 'DROP_INCOME',
          status: 'VALIDATED',
          amount: '1500',
          currency: 'USDT',
          senderId: null,
          senderLabel: 'TechCorp A',
          receiverId: DROP_A.id,
          recipientId: DROP_A.id,
          projectId: PROJ_A_ID,
          txDate: new Date('2026-06-12T00:00:00Z'),
          createdBy: DROP_A.id,
        },
        {
          id: INCOME_A2_ID,
          type: 'DROP_INCOME',
          status: 'PENDING',
          amount: '800',
          currency: 'USDT',
          senderId: null,
          senderLabel: 'TechCorp A',
          receiverId: DROP_A.id,
          recipientId: DROP_A.id,
          projectId: PROJ_A_ID,
          txDate: new Date('2026-06-10T00:00:00Z'),
          createdBy: DROP_A.id,
        },
        {
          id: PAYOUT_A_ID,
          type: 'PAYOUT',
          status: 'PENDING_PAYMENT',
          amount: '1425',
          currency: 'USDT',
          senderId: DROP_A.id,
          receiverLabel: 'CheekyCheeseIT',
          txHash: '0x' + 'a'.repeat(64),
          projectId: PROJ_A_ID,
          createdBy: DROP_A.id,
        },
      ])
      .onConflictDoNothing()
  }, 30_000)

  afterAll(async () => {
    if (!dbAvailable) return
    try {
      const db = dbSvc.db
      await db
        .delete(transactions)
        .where(
          inArray(transactions.id, [
            INCOME_B_ID,
            PAYOUT_B_ID,
            INCOME_A1_ID,
            INCOME_A2_ID,
            PAYOUT_A_ID,
          ]),
        )
      await db.delete(payoutRequests).where(inArray(payoutRequests.id, [PAYOUT_REQ_B_ID]))
      await db.delete(projects).where(inArray(projects.id, [PROJ_B_ID, PROJ_A_ID]))
      await db.delete(teamMembers).where(inArray(teamMembers.teamId, [TEAM_A_ID, TEAM_B_ID]))
      await db.delete(teams).where(inArray(teams.id, [TEAM_A_ID, TEAM_B_ID]))
      await db.delete(users).where(inArray(users.id, TEST_USER_IDS))
    } catch {
      // non-fatal
    }
    await app.close()
  }, 15_000)

  function tokenFor(user: SessionUser): string {
    return jwt.sign(user)
  }

  // ── teams list / detail (AC6) ───────────────────────────────────────────────

  it('TEAMS list: Drop A sees ONLY their own drop-team', async () => {
    if (!dbAvailable) return
    const res = await app.inject({
      method: 'GET',
      url: '/api/teams',
      cookies: { jwt: tokenFor(DROP_A) },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as Array<{ id: string }>
    expect(body.map((t) => t.id)).toEqual([TEAM_A_ID])
  })

  it("TEAMS detail: Drop A reading Drop B's team → 403", async () => {
    if (!dbAvailable) return
    const res = await app.inject({
      method: 'GET',
      url: `/api/teams/${TEAM_B_ID}`,
      cookies: { jwt: tokenFor(DROP_A) },
    })
    expect(res.statusCode).toBe(403)
  })

  it('TEAMS detail: Drop A reading their OWN team → 200', async () => {
    if (!dbAvailable) return
    const res = await app.inject({
      method: 'GET',
      url: `/api/teams/${TEAM_A_ID}`,
      cookies: { jwt: tokenFor(DROP_A) },
    })
    expect(res.statusCode).toBe(200)
  })

  // ── drop/me/summary (AC6) ───────────────────────────────────────────────────

  it("SUMMARY: Drop A → 200 with own $1425 debt (B's $950 must NOT leak)", async () => {
    if (!dbAvailable) return
    const res = await app.inject({
      method: 'GET',
      url: '/api/finance/drop/me/summary',
      cookies: { jwt: tokenFor(DROP_A) },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { debtToCompany: number; balance: number }
    // task-drop-2-backend seeded Drop A's own PENDING_PAYMENT PAYOUT ($1425),
    // so A's debt is exactly that. Crucially Drop B's $950 PENDING_PAYMENT payout
    // must NOT leak into Drop A's debt (cross-drop isolation). balance stays 0
    // (no PAYOUT_DROP credit/debit rows for A).
    expect(body.debtToCompany).toBe(1425)
    expect(body.balance).toBe(0)
  })

  it('SUMMARY: Drop B → 200 and sees their OWN $950 debt', async () => {
    if (!dbAvailable) return
    const res = await app.inject({
      method: 'GET',
      url: '/api/finance/drop/me/summary',
      cookies: { jwt: tokenFor(DROP_B) },
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { debtToCompany: number }).debtToCompany).toBe(950)
  })

  const nonDropRoles: Array<[string, SessionUser]> = [
    ['SENIOR', SENIOR],
    ['JUNIOR', JUNIOR],
    ['HR', HR],
    ['ACCOUNTANT', ACCOUNTANT],
    ['ADMIN', MAKSYM],
  ]
  for (const [label, persona] of nonDropRoles) {
    it(`SUMMARY: ${label} → 403`, async () => {
      if (!dbAvailable) return
      const res = await app.inject({
        method: 'GET',
        url: '/api/finance/drop/me/summary',
        cookies: { jwt: tokenFor(persona) },
      })
      expect(res.statusCode).toBe(403)
    })
  }

  // ── drop/me/incomes — self-only feed + cross-drop IDOR (AC6) ────────────────

  it('INCOMES: Drop A sees ONLY their own DROP_INCOME rows (B incomes never leak)', async () => {
    if (!dbAvailable) return
    const res = await app.inject({
      method: 'GET',
      url: '/api/finance/drop/me/incomes',
      cookies: { jwt: tokenFor(DROP_A) },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { items: Array<{ id: string }>; total: number }
    const ids = body.items.map((i) => i.id)
    // A's two incomes present; B's income absent (IDOR class).
    expect(ids).toContain(INCOME_A1_ID)
    expect(ids).toContain(INCOME_A2_ID)
    expect(ids).not.toContain(INCOME_B_ID)
    expect(body.total).toBe(2)
  })

  it('INCOMES: Drop B sees ONLY their own income (A incomes never leak)', async () => {
    if (!dbAvailable) return
    const res = await app.inject({
      method: 'GET',
      url: '/api/finance/drop/me/incomes',
      cookies: { jwt: tokenFor(DROP_B) },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { items: Array<{ id: string }> }
    const ids = body.items.map((i) => i.id)
    expect(ids).toContain(INCOME_B_ID)
    expect(ids).not.toContain(INCOME_A1_ID)
    expect(ids).not.toContain(INCOME_A2_ID)
  })

  it('INCOMES: status filter narrows to validated only', async () => {
    if (!dbAvailable) return
    const res = await app.inject({
      method: 'GET',
      url: '/api/finance/drop/me/incomes?status=validated',
      cookies: { jwt: tokenFor(DROP_A) },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { items: Array<{ id: string; status: string }>; total: number }
    expect(body.total).toBe(1)
    expect(body.items[0]!.id).toBe(INCOME_A1_ID)
    expect(body.items[0]!.status).toBe('validated')
  })

  it('INCOMES: pagination — limit=1 returns 1 item, total reflects full count', async () => {
    if (!dbAvailable) return
    const res = await app.inject({
      method: 'GET',
      url: '/api/finance/drop/me/incomes?page=1&limit=1',
      cookies: { jwt: tokenFor(DROP_A) },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { items: unknown[]; total: number; page: number; limit: number }
    expect(body.items).toHaveLength(1)
    expect(body.total).toBe(2)
    expect(body.limit).toBe(1)
  })

  for (const [label, persona] of [
    ['SENIOR', SENIOR],
    ['JUNIOR', JUNIOR],
    ['HR', HR],
    ['ACCOUNTANT', ACCOUNTANT],
    ['ADMIN', MAKSYM],
  ] as Array<[string, SessionUser]>) {
    it(`INCOMES: ${label} → 403`, async () => {
      if (!dbAvailable) return
      const res = await app.inject({
        method: 'GET',
        url: '/api/finance/drop/me/incomes',
        cookies: { jwt: tokenFor(persona) },
      })
      expect(res.statusCode).toBe(403)
    })
  }

  // ── projects/drop/me — self-only feed + route-ordering (AC6 / AC5) ──────────

  it('PROJECTS: Drop A sees ONLY their own drop-project with correct incomesCount', async () => {
    if (!dbAvailable) return
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects/drop/me',
      cookies: { jwt: tokenFor(DROP_A) },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as Array<{
      id: string
      companyName: string
      seniorDisplayName: string
      incomesCount: number
      status: string
    }>
    expect(body.map((p) => p.id)).toEqual([PROJ_A_ID])
    expect(body[0]!.companyName).toBe('TechCorp A')
    // Real senior display name (NOT masked).
    expect(body[0]!.seniorDisplayName).toBe(SENIOR.displayName)
    // Two DROP_INCOME rows on this project.
    expect(body[0]!.incomesCount).toBe(2)
    expect(body[0]!.status).toBe('active')
  })

  it("PROJECTS: Drop B never sees Drop A's project", async () => {
    if (!dbAvailable) return
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects/drop/me',
      cookies: { jwt: tokenFor(DROP_B) },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as Array<{ id: string }>
    expect(body.map((p) => p.id)).toEqual([PROJ_B_ID])
    expect(body.map((p) => p.id)).not.toContain(PROJ_A_ID)
  })

  it('PROJECTS: route-ordering — static drop/me is NOT captured by the :id param route', async () => {
    if (!dbAvailable) return
    // If `drop/me` were declared AFTER `@Get(':id')`, find-my-way would route
    // `drop` into `:id` and the ParseUUIDPipe would 400 (or NotFound). A 200
    // proves the static literal wins.
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects/drop/me',
      cookies: { jwt: tokenFor(DROP_A) },
    })
    expect(res.statusCode).toBe(200)
  })

  for (const [label, persona] of [
    ['SENIOR', SENIOR],
    ['JUNIOR', JUNIOR],
    ['HR', HR],
    ['ACCOUNTANT', ACCOUNTANT],
    ['ADMIN', MAKSYM],
  ] as Array<[string, SessionUser]>) {
    it(`PROJECTS: ${label} → 403`, async () => {
      if (!dbAvailable) return
      const res = await app.inject({
        method: 'GET',
        url: '/api/projects/drop/me',
        cookies: { jwt: tokenFor(persona) },
      })
      expect(res.statusCode).toBe(403)
    })
  }

  // ── drop/me/payments — self-only feed + cross-drop IDOR (AC6) ───────────────

  it("PAYMENTS: Drop A sees ONLY their own PAYOUT (B's payout never leaks)", async () => {
    if (!dbAvailable) return
    const res = await app.inject({
      method: 'GET',
      url: '/api/finance/drop/me/payments',
      cookies: { jwt: tokenFor(DROP_A) },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as Array<{
      id: string
      amount: number
      status: string
      txHash?: string
    }>
    expect(body.map((p) => p.id)).toEqual([PAYOUT_A_ID])
    expect(body[0]!.amount).toBe(1425)
    expect(body[0]!.status).toBe('pending')
    expect(body[0]!.txHash).toBe('0x' + 'a'.repeat(64))
  })

  it("PAYMENTS: Drop B sees ONLY their own PAYOUT (A's payout never leaks)", async () => {
    if (!dbAvailable) return
    const res = await app.inject({
      method: 'GET',
      url: '/api/finance/drop/me/payments',
      cookies: { jwt: tokenFor(DROP_B) },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as Array<{ id: string }>
    expect(body.map((p) => p.id)).toEqual([PAYOUT_B_ID])
    expect(body.map((p) => p.id)).not.toContain(PAYOUT_A_ID)
  })

  for (const [label, persona] of [
    ['SENIOR', SENIOR],
    ['JUNIOR', JUNIOR],
    ['HR', HR],
    ['ACCOUNTANT', ACCOUNTANT],
    ['ADMIN', MAKSYM],
  ] as Array<[string, SessionUser]>) {
    it(`PAYMENTS: ${label} → 403`, async () => {
      if (!dbAvailable) return
      const res = await app.inject({
        method: 'GET',
        url: '/api/finance/drop/me/payments',
        cookies: { jwt: tokenFor(persona) },
      })
      expect(res.statusCode).toBe(403)
    })
  }

  // ── transaction ownership (AC6 / AC5) ────────────────────────────────────────

  it("GET /transactions/:id of Drop B's income → 403 for Drop A", async () => {
    if (!dbAvailable) return
    const res = await app.inject({
      method: 'GET',
      url: `/api/transactions/${INCOME_B_ID}`,
      cookies: { jwt: tokenFor(DROP_A) },
    })
    expect(res.statusCode).toBe(403)
  })

  it('GET /transactions/:id of own income → 200 for Drop B', async () => {
    if (!dbAvailable) return
    const res = await app.inject({
      method: 'GET',
      url: `/api/transactions/${INCOME_B_ID}`,
      cookies: { jwt: tokenFor(DROP_B) },
    })
    expect(res.statusCode).toBe(200)
  })

  // ── payment-channel ownership (AC6 / AC5) ────────────────────────────────────

  it("POST /payments/initiate-crypto with Drop B's incomeId → 403 for Drop A", async () => {
    if (!dbAvailable) return
    const res = await app.inject({
      method: 'POST',
      url: '/api/payments/initiate-crypto',
      cookies: { jwt: tokenFor(DROP_A) },
      payload: { incomeId: INCOME_B_ID },
    })
    expect(res.statusCode).toBe(403)
  })

  it("POST /payments/confirm-crypto with Drop B's incomeId → 403 for Drop A", async () => {
    if (!dbAvailable) return
    const res = await app.inject({
      method: 'POST',
      url: '/api/payments/confirm-crypto',
      cookies: { jwt: tokenFor(DROP_A) },
      payload: { incomeId: INCOME_B_ID, txHashes: ['0x' + 'a'.repeat(64)] },
    })
    expect(res.statusCode).toBe(403)
  })

  it('POST /payments/initiate-crypto with OWN incomeId → 201 for Drop B (proves the guard allows the owner)', async () => {
    if (!dbAvailable) return
    // NestJS @Post() defaults to 201 Created on success. The point of this
    // positive case is that Drop B (the owner) is NOT forbidden — contrast
    // with the 403 Drop A receives for the same income above.
    const res = await app.inject({
      method: 'POST',
      url: '/api/payments/initiate-crypto',
      cookies: { jwt: tokenFor(DROP_B) },
      payload: { incomeId: INCOME_B_ID },
    })
    expect(res.statusCode).toBe(201)
    // And the recipients are the 2 admin partners (sanity on the happy path).
    const body = res.json() as { recipients: Array<{ role: string }> }
    expect(body.recipients.length).toBeGreaterThan(0)
  })
})
