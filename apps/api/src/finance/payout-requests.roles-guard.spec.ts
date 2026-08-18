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
import { PayoutRequestsController } from './transactions.controller'
import { TransactionsService } from './transactions.service'

/**
 * backlog item 128 (security-review #566) — `PayoutRequestsController`
 * carried NO class-level `@UseGuards(RolesGuard)`; only `manual-confirm`
 * brought its own method-level guard. `POST /payout-requests` (create) and
 * `PATCH /payout-requests/:id/pay` (pay) — the two money-out routes — were
 * held up by NOTHING but `TransactionsService`'s own role check
 * (`currentUser.role !== 'SENIOR' && currentUser.role !== 'DROP'` — see
 * `createPayoutRequest` / `payPayoutRequest`). Severity note (do not
 * re-inflate on a future pass): the binding constraint on both routes is
 * OWNERSHIP, not role — the service locks/looks up rows scoped to
 * `currentUser.id`, so a stray role simply has no matching rows. This spec
 * proves the ADDED layer, not the pre-existing one.
 *
 * WHY A STUB SERVICE THAT NEVER THROWS (mirrors
 * transactions.summary.roles-guard.spec.ts, the pattern security-review
 * #566 pointed at). `payout-manual-confirm.rbac.integration.spec.ts` and
 * the finance-controller-guards suite already prove SERVICE-side checks
 * end-to-end against a real DB. This spec mounts the REAL
 * `PayoutRequestsController` (so the REAL `@Roles('SENIOR','DROP')` +
 * REAL class-level `@UseGuards(RolesGuard)` are exercised) but replaces
 * `TransactionsService` with a stub whose `createPayoutRequest` /
 * `payPayoutRequest` ALWAYS resolve — they can never produce a 403 on
 * their own. So:
 *   - a forbidden role getting 403 can ONLY come from the guard, and
 *   - the call-counter assertions prove the stub handler was never
 *     reached, i.e. the guard rejected the request BEFORE the controller
 *     method ran.
 *
 * PROOF THIS TEST CAN FAIL (AC2 — "умеет краснеть"): temporarily removing
 * `@Roles('SENIOR', 'DROP')` from `create`/`pay` in transactions.controller.ts
 * turns `RolesGuard.canActivate` back into the NO-OP it is when no `@Roles`
 * metadata is present (returns `true` unconditionally). With the stub never
 * throwing, every "→ 403" case below then resolves 200/201 instead and the
 * matching call-counter becomes 1 instead of 0 — every forbidden-role test
 * fails. Verified by hand while writing this spec: removing ONLY the
 * `create` decorator reddens exactly the `create`-describe block (the `pay`
 * block, still decorated, stays green) and vice versa — proving the two
 * decorators are independently load-bearing, not just "some guard fired
 * somewhere". Restoring either decorator turns its block back green with no
 * other change.
 *
 * No DATABASE_URL needed — `.spec.ts` (not `.integration.spec.ts`), runs in
 * the ordinary unit-test job every time, never DB-skipped.
 *
 * security-review round on #577 (LOW-1) added `GET /payout-requests/:id`
 * coverage below: `TransactionsService.findPayoutRequest` throws
 * `ForbiddenException` UNCONDITIONALLY for any role outside `{ADMIN,
 * ACCOUNTANT, SENIOR, DROP}` — that fixed superset (not a per-row ownership
 * check) is exactly what `@Roles('ADMIN','ACCOUNTANT','SENIOR','DROP')` on
 * `findOne` expresses. HR/JUNIOR are proven rejected by the guard here;
 * SENIOR/DROP/ADMIN/ACCOUNTANT reach the (always-succeeding) stub — this
 * spec cannot and does not claim to prove the FINER per-row ownership check
 * still inside the service (a non-owning SENIOR, say) — that is pinned
 * separately against a real DB.
 */

const JWT_SECRET = 'payout-requests-roles-guard-spec-secret-32ch'

function persona(role: SessionUser['role'], suffix: string): SessionUser {
  return {
    id: `9b120000-0000-4000-aa00-0000000000${suffix}`,
    email: `prrg-${role.toLowerCase()}@test.spec`,
    displayName: `PRRG ${role}`,
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

// Fixed uuid so `createPayoutRequestSchema.parse` (called INSIDE the
// handler, i.e. only reached when the guard lets the request through) never
// fails on shape — the point of this spec is the guard layer, not the body
// validator.
const SOME_TX_ID = 'a1b2c3d4-0000-4000-8000-000000000001'
const SOME_REQUEST_ID = 'a1b2c3d4-0000-4000-8000-000000000002'

const FIXED_PAYOUT = {
  id: SOME_REQUEST_ID,
  status: 'PENDING',
} as const

let createCalls = 0
let payCalls = 0
let findOneCalls = 0
const stubTransactionsService = {
  createPayoutRequest: () => {
    createCalls++
    return Promise.resolve(FIXED_PAYOUT)
  },
  payPayoutRequest: () => {
    payCalls++
    return Promise.resolve({ ...FIXED_PAYOUT, status: 'PAID' })
  },
  findPayoutRequest: () => {
    findOneCalls++
    return Promise.resolve(FIXED_PAYOUT)
  },
} as unknown as TransactionsService

@Module({
  imports: [JwtModule.register({ secret: JWT_SECRET, signOptions: { expiresIn: '1h' } })],
  controllers: [PayoutRequestsController],
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
class PayoutRequestsRolesGuardTestModule {}

describe('PayoutRequestsController — @Roles guard layer (stub service, never throws)', () => {
  let app: NestFastifyApplication
  let jwt: JwtService

  beforeAll(async () => {
    // Mirrors transactions.summary.roles-guard.spec.ts: `.overrideGuard`
    // guarantees the REAL `RolesGuard` referenced by
    // `@UseGuards(RolesGuard)` on `PayoutRequestsController` is the instance
    // actually exercised, without needing to list it among the module's own
    // providers.
    const moduleRef = await Test.createTestingModule({
      imports: [PayoutRequestsRolesGuardTestModule],
    })
      .overrideGuard(RolesGuard)
      .useValue(new RolesGuard(new Reflector()))
      .compile()

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    await app.register(cookie, { secret: 'payout-requests-roles-guard-spec-cookie-secret' })
    app.setGlobalPrefix('api')
    await app.init()
    await app.getHttpAdapter().getInstance().ready()

    jwt = moduleRef.get(JwtService)
  }, 15_000)

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    createCalls = 0
    payCalls = 0
    findOneCalls = 0
  })

  function tokenFor(user: SessionUser): string {
    return jwt.sign(user)
  }

  async function createPayout(user: SessionUser) {
    return app.inject({
      method: 'POST',
      url: '/api/payout-requests',
      cookies: { jwt: tokenFor(user) },
      payload: { transactionIds: [SOME_TX_ID] },
    })
  }

  async function payPayout(user: SessionUser) {
    return app.inject({
      method: 'PATCH',
      url: `/api/payout-requests/${SOME_REQUEST_ID}/pay`,
      cookies: { jwt: tokenFor(user) },
      payload: { txHash: '0x'.padEnd(66, 'a') },
    })
  }

  async function getPayout(user: SessionUser) {
    return app.inject({
      method: 'GET',
      url: `/api/payout-requests/${SOME_REQUEST_ID}`,
      cookies: { jwt: tokenFor(user) },
    })
  }

  const forbidden: Array<[string, SessionUser]> = [
    ['ADMIN', ADMIN],
    ['ACCOUNTANT', ACCOUNTANT],
    ['JUNIOR', JUNIOR],
    ['HR', HR],
  ]
  const allowed: Array<[string, SessionUser]> = [
    ['SENIOR', SENIOR],
    ['DROP', DROP],
  ]

  describe('POST /api/payout-requests', () => {
    for (const [label, user] of forbidden) {
      it(`${label} → 403 AND the handler is never called (guard rejects before it runs)`, async () => {
        const res = await createPayout(user)
        expect(res.statusCode).toBe(403)
        // The stub can only ever return 201 — a 403 here is impossible
        // unless the guard itself threw, and createCalls staying 0 proves
        // the request never reached the (always-succeeding) handler.
        expect(createCalls).toBe(0)
      })
    }

    for (const [label, user] of allowed) {
      it(`${label} → 201, handler reached (guard lets it through)`, async () => {
        const res = await createPayout(user)
        expect(res.statusCode).toBe(201)
        expect(JSON.parse(res.payload)).toEqual(FIXED_PAYOUT)
        expect(createCalls).toBe(1)
      })
    }
  })

  describe('PATCH /api/payout-requests/:id/pay', () => {
    for (const [label, user] of forbidden) {
      it(`${label} → 403 AND the handler is never called (guard rejects before it runs)`, async () => {
        const res = await payPayout(user)
        expect(res.statusCode).toBe(403)
        expect(payCalls).toBe(0)
      })
    }

    for (const [label, user] of allowed) {
      it(`${label} → 200, handler reached (guard lets it through)`, async () => {
        const res = await payPayout(user)
        expect(res.statusCode).toBe(200)
        expect(JSON.parse(res.payload)).toEqual({ ...FIXED_PAYOUT, status: 'PAID' })
        expect(payCalls).toBe(1)
      })
    }
  })

  // LOW-1 (security-review round on #577): `@Roles('ADMIN','ACCOUNTANT',
  // 'SENIOR','DROP')` on `findOne` is the FIXED superset of roles that can
  // ever pass `findPayoutRequest`'s service-side check — ADMIN/ACCOUNTANT
  // unconditionally, SENIOR/DROP only when they own the row (this spec's
  // stub cannot distinguish ownership — it always resolves — so ONLY the
  // categorically-ineligible roles belong in `forbiddenByRole` below).
  describe('GET /api/payout-requests/:id', () => {
    const forbiddenByRole: Array<[string, SessionUser]> = [
      ['JUNIOR', JUNIOR],
      ['HR', HR],
    ]
    const allowedByRole: Array<[string, SessionUser]> = [
      ['ADMIN', ADMIN],
      ['ACCOUNTANT', ACCOUNTANT],
      ['SENIOR', SENIOR],
      ['DROP', DROP],
    ]

    for (const [label, user] of forbiddenByRole) {
      it(`${label} → 403 AND the handler is never called (guard rejects before it runs)`, async () => {
        const res = await getPayout(user)
        expect(res.statusCode).toBe(403)
        // The stub can only ever return 200 — a 403 here is impossible
        // unless the guard itself threw, and findOneCalls staying 0 proves
        // the request never reached the (always-succeeding) handler.
        expect(findOneCalls).toBe(0)
      })
    }

    for (const [label, user] of allowedByRole) {
      it(`${label} → 200, handler reached (guard lets it through)`, async () => {
        const res = await getPayout(user)
        expect(res.statusCode).toBe(200)
        expect(JSON.parse(res.payload)).toEqual(FIXED_PAYOUT)
        expect(findOneCalls).toBe(1)
      })
    }
  })
})
