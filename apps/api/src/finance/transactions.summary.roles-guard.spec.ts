import { Module } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { JwtModule, JwtService } from '@nestjs/jwt'
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import cookie from '@fastify/cookie'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'

import { JwtAuthGuard } from '../auth/jwt.guard'
import { RolesGuard } from '../common/guards/roles.guard'
import { FinanceSummaryController } from './transactions.controller'
import { TransactionsService } from './transactions.service'
import { NbuCurrencyService } from './nbu-currency.service'

/**
 * BACKLOG item 121 (security-review on #560) — GET /api/finance/summary was
 * decorated with `@Roles('ADMIN','ACCOUNTANT')` in the SAME commit that added
 * this spec. Before that, `@UseGuards(RolesGuard)` on `FinanceSummaryController`
 * was a NO-OP for this route: `RolesGuard.canActivate` returns `true`
 * immediately when no `@Roles` metadata is present (see roles.guard.ts), so the
 * ONLY thing standing between a SENIOR/JUNIOR/HR/DROP caller and the handler was
 * `TransactionsService.getSummary`'s own `ForbiddenException`. One deleted `if`
 * there would have opened the route to everyone.
 *
 * WHY A STUB SERVICE THAT NEVER THROWS (the point of this file):
 * `transactions.summary.rbac.integration.spec.ts` already proves the SERVICE
 * check end-to-end against a real DB — but it mounts a sentinel controller with
 * no `@UseGuards`/`@Roles` at all, so its 403s are 100% attributable to the
 * service. That is exactly the "mocked/sentinel gives false confidence for
 * endpoints behind guards" trap (feedback_mocked_e2e_guards, recurred 3×) —
 * inverted: a passing sentinel-403 test proves NOTHING about the guard layer.
 *
 * This spec mounts the REAL `FinanceSummaryController` (so the REAL `@Roles`
 * decorator + REAL class-level `@UseGuards(RolesGuard)` are exercised) but
 * replaces `TransactionsService` with a stub whose `getSummary` ALWAYS resolves
 * — it can never produce a 403 on its own. So:
 *   - a forbidden role getting 403 can ONLY come from the guard, and
 *   - the call-counter assertion proves the stub handler was never reached,
 *     i.e. the guard rejected the request BEFORE the controller method ran.
 *
 * PROOF THIS TEST CAN FAIL (AC5 — "умеет краснеть"): temporarily removing
 * `@Roles('ADMIN','ACCOUNTANT')` from `getSummary` in transactions.controller.ts
 * turns `RolesGuard.canActivate` back into the NO-OP described above. With the
 * stub never throwing, every one of the "→ 403" cases below would then resolve
 * 200 and `getSummaryCalls` would be 1 instead of 0 — every forbidden-role test
 * fails. Verified by hand while writing this spec (see the task's final report
 * for the captured red-then-green output); restoring the decorator turns it
 * back green with no other change.
 *
 * No DATABASE_URL needed — `.spec.ts` (not `.integration.spec.ts`), runs in the
 * ordinary unit-test job every time, never DB-skipped.
 */

const JWT_SECRET = 'summary-roles-guard-spec-secret-32chars-x'

function persona(role: SessionUser['role'], suffix: string): SessionUser {
  return {
    id: `9b110000-0000-4000-aa00-0000000000${suffix}`,
    email: `srg-${role.toLowerCase()}@test.spec`,
    displayName: `SRG ${role}`,
    avatarUrl: null,
    role,
    seniorSharePercent: 0,
    legalFullName: null,
  }
}

const ADMIN = persona('ADMIN', '01')
const ACCOUNTANT = persona('ACCOUNTANT', '02')
const SENIOR = persona('SENIOR', '03')
const JUNIOR = persona('JUNIOR', '04')
const HR = persona('HR', '05')
const DROP = persona('DROP', '06')

// The exact payload shape is irrelevant to this spec (fidelity to
// FinanceSummaryDto is pinned elsewhere — the unit spec + the real-DB RBAC
// integration spec). What matters here is that this stub NEVER throws, for
// ANY caller, so a 403 in this file can only originate from the guard.
const FIXED_SUMMARY = {
  totalIncome: 0,
  totalExpenses: 0,
  totalSalaries: 0,
  netBalance: 0,
  monthly: [],
  adminBalances: [],
  dropBalances: [],
}

let getSummaryCalls = 0
const stubTransactionsService = {
  getSummary: () => {
    getSummaryCalls++
    return Promise.resolve(FIXED_SUMMARY)
  },
} as unknown as TransactionsService

const stubNbu = {
  getRates: () =>
    Promise.resolve({ usdUah: '40.0000', usdtUah: '40.0000', eurUah: '44.0000', date: '20260101' }),
} as unknown as NbuCurrencyService

@Module({
  imports: [JwtModule.register({ secret: JWT_SECRET, signOptions: { expiresIn: '1h' } })],
  controllers: [FinanceSummaryController],
  providers: [
    Reflector,
    { provide: TransactionsService, useValue: stubTransactionsService },
    { provide: NbuCurrencyService, useValue: stubNbu },
    {
      provide: APP_GUARD,
      useFactory: (jwtSvc: JwtService, reflector: Reflector) => new JwtAuthGuard(jwtSvc, reflector),
      inject: [JwtService, Reflector],
    },
  ],
})
class SummaryRolesGuardTestModule {}

describe('GET /api/finance/summary — @Roles guard layer (stub service, never throws)', () => {
  let app: NestFastifyApplication
  let jwt: JwtService

  beforeAll(async () => {
    // Mirrors finance-controller-guards.rbac.integration.spec.ts: `.overrideGuard`
    // guarantees the REAL `RolesGuard` referenced by `@UseGuards(RolesGuard)` on
    // `FinanceSummaryController` is the instance actually exercised, without
    // needing to list it among the module's own providers.
    const moduleRef = await Test.createTestingModule({ imports: [SummaryRolesGuardTestModule] })
      .overrideGuard(RolesGuard)
      .useValue(new RolesGuard(new Reflector()))
      .compile()

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    await app.register(cookie, { secret: 'summary-roles-guard-spec-cookie-secret' })
    app.setGlobalPrefix('api')
    await app.init()
    await app.getHttpAdapter().getInstance().ready()

    jwt = moduleRef.get(JwtService)
  }, 15_000)

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    getSummaryCalls = 0
  })

  function tokenFor(user: SessionUser): string {
    return jwt.sign(user)
  }

  async function summary(user: SessionUser) {
    return app.inject({
      method: 'GET',
      url: '/api/finance/summary',
      cookies: { jwt: tokenFor(user) },
    })
  }

  const forbidden: Array<[string, SessionUser]> = [
    ['SENIOR', SENIOR],
    ['JUNIOR', JUNIOR],
    ['HR', HR],
    ['DROP', DROP],
  ]
  for (const [label, user] of forbidden) {
    it(`${label} → 403 AND the handler is never called (guard rejects before it runs)`, async () => {
      const res = await summary(user)
      expect(res.statusCode).toBe(403)
      // The stub can only return 200 — a 403 here is impossible unless the
      // guard itself threw, and getSummaryCalls staying 0 proves the request
      // never reached the (always-succeeding) handler.
      expect(getSummaryCalls).toBe(0)
    })
  }

  const allowed: Array<[string, SessionUser]> = [
    ['ADMIN', ADMIN],
    ['ACCOUNTANT', ACCOUNTANT],
  ]
  for (const [label, user] of allowed) {
    it(`${label} → 200, handler reached (guard lets it through)`, async () => {
      const res = await summary(user)
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.payload)).toEqual(FIXED_SUMMARY)
      expect(getSummaryCalls).toBe(1)
    })
  }
})
