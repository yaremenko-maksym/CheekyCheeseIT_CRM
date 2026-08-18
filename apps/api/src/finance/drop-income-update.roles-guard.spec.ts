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
import { TransactionsController } from './transactions.controller'
import { TransactionsService } from './transactions.service'

/**
 * backlog item 128 follow-up — security-review round on PR #577 (MED-1).
 *
 * `PATCH /transactions/drop-income/:id` (BIZ-17 resubmit path) carried NO
 * `@Roles` at all. The claim in the controller comment used to be "ownership
 * is the gate, no @Roles needed" — wrong: `TransactionsService.
 * updateDropIncome` runs TWO independent checks, `currentUser.role !==
 * 'DROP'` FIRST (an exact role check, same shape as `createDropIncome`'s
 * `@Roles('DROP')` right above it in this same controller), THEN
 * `tx.receiverId === currentUser.id` for ownership of THAT transaction.
 * `@Roles('DROP')` can express the first; it cannot express the second,
 * which stays service-side (unchanged by this spec or the fix it pins).
 *
 * WHY A STUB SERVICE THAT NEVER THROWS (same pattern as
 * transactions.summary.roles-guard.spec.ts / payout-requests.roles-guard.
 * spec.ts). This spec mounts the REAL `TransactionsController` (so the REAL
 * `@Roles('DROP')` + REAL class-level `@UseGuards(RolesGuard)` are
 * exercised) but replaces `TransactionsService` with a stub whose
 * `updateDropIncome` ALWAYS resolves — it can never produce a 403 on its
 * own. So:
 *   - a forbidden role getting 403 can ONLY come from the guard, and
 *   - the call-counter assertion proves the stub handler was never reached,
 *     i.e. the guard rejected the request BEFORE the controller method ran.
 *
 * PROOF THIS TEST CAN FAIL: temporarily removing `@Roles('DROP')` from
 * `updateDropIncome` in transactions.controller.ts turns `RolesGuard.
 * canActivate` back into the NO-OP it is when no `@Roles` metadata is
 * present. With the stub never throwing, every "→ 403" case below then
 * resolves 200 instead and `updateCalls` becomes 1 instead of 0. Verified by
 * hand while writing this spec (see the task report for the captured
 * red-then-green output); restoring the decorator turns it back green with
 * no other change.
 *
 * No DATABASE_URL needed — `.spec.ts` (not `.integration.spec.ts`), runs in
 * the ordinary unit-test job every time, never DB-skipped.
 */

const JWT_SECRET = 'drop-income-update-roles-guard-spec-secret-32c'

function persona(role: SessionUser['role'], suffix: string): SessionUser {
  return {
    id: `9b130000-0000-4000-aa00-0000000000${suffix}`,
    email: `diurg-${role.toLowerCase()}@test.spec`,
    displayName: `DIURG ${role}`,
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

const SOME_TX_ID = 'b1c2d3e4-0000-4000-8000-000000000001'

const FIXED_TX = {
  id: SOME_TX_ID,
  type: 'DROP_INCOME',
  status: 'PENDING',
} as const

let updateCalls = 0
const stubTransactionsService = {
  updateDropIncome: () => {
    updateCalls++
    return Promise.resolve(FIXED_TX)
  },
} as unknown as TransactionsService

@Module({
  imports: [JwtModule.register({ secret: JWT_SECRET, signOptions: { expiresIn: '1h' } })],
  controllers: [TransactionsController],
  providers: [
    Reflector,
    { provide: TransactionsService, useValue: stubTransactionsService },
    {
      provide: APP_GUARD,
      useFactory: (jwtSvc: JwtService, reflector: Reflector) => new JwtAuthGuard(jwtSvc, reflector),
      inject: [JwtService, Reflector],
    },
  ],
})
class DropIncomeUpdateRolesGuardTestModule {}

describe('PATCH /api/transactions/drop-income/:id — @Roles guard layer (stub service, never throws)', () => {
  let app: NestFastifyApplication
  let jwt: JwtService

  beforeAll(async () => {
    // Mirrors payout-requests.roles-guard.spec.ts: `.overrideGuard`
    // guarantees the REAL `RolesGuard` referenced by
    // `@UseGuards(RolesGuard)` on `TransactionsController` is the instance
    // actually exercised, without needing to list it among the module's own
    // providers.
    const moduleRef = await Test.createTestingModule({
      imports: [DropIncomeUpdateRolesGuardTestModule],
    })
      .overrideGuard(RolesGuard)
      .useValue(new RolesGuard(new Reflector()))
      .compile()

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    await app.register(cookie, { secret: 'drop-income-update-roles-guard-spec-cookie-secret' })
    app.setGlobalPrefix('api')
    await app.init()
    await app.getHttpAdapter().getInstance().ready()

    jwt = moduleRef.get(JwtService)
  }, 15_000)

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    updateCalls = 0
  })

  function tokenFor(user: SessionUser): string {
    return jwt.sign(user)
  }

  async function updateDropIncome(user: SessionUser) {
    return app.inject({
      method: 'PATCH',
      url: `/api/transactions/drop-income/${SOME_TX_ID}`,
      cookies: { jwt: tokenFor(user) },
      payload: { notes: 'resubmitting' },
    })
  }

  const forbidden: Array<[string, SessionUser]> = [
    ['ADMIN', ADMIN],
    ['ACCOUNTANT', ACCOUNTANT],
    ['SENIOR', SENIOR],
    ['JUNIOR', JUNIOR],
    ['HR', HR],
  ]

  for (const [label, user] of forbidden) {
    it(`${label} → 403 AND the handler is never called (guard rejects before it runs)`, async () => {
      const res = await updateDropIncome(user)
      expect(res.statusCode).toBe(403)
      // The stub can only ever return 200 — a 403 here is impossible unless
      // the guard itself threw, and updateCalls staying 0 proves the request
      // never reached the (always-succeeding) handler.
      expect(updateCalls).toBe(0)
    })
  }

  it('DROP → 200, handler reached (guard lets it through)', async () => {
    const res = await updateDropIncome(DROP)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload)).toEqual(FIXED_TX)
    expect(updateCalls).toBe(1)
  })
})
