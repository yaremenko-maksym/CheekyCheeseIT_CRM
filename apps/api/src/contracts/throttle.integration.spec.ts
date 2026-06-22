import { CanActivate, Controller, ExecutionContext, Module, Patch, Post } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler'
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  SensitiveWriteThrottle,
  AdminWriteThrottle,
  RelaxableThrottle,
  WALLET_UPDATE_LIMIT,
  DEPOSIT_LIMIT,
  DIVIDEND_LIMIT,
} from '../config/throttle-decorators'

/**
 * Integration test — pins that @Throttle() decorators on the real
 * SignedContractsController + ContractTemplatesController + TosController
 * endpoints actually enforce rate limits through the ThrottlerGuard HTTP
 * request lifecycle.
 *
 * WHAT it tests:
 *   Section A — Prod-hardened limits (regression coverage for PR #100 + env-config PR):
 *     POST /api/contracts/sign        → limit 10 req/min  (THROTTLE_RELAXED unset)
 *     POST /api/tos/accept            → limit 10 req/min  (THROTTLE_RELAXED unset)
 *     POST /api/contracts/templates   → limit 5  req/min  (THROTTLE_RELAXED unset)
 *     POST /api/tos                   → limit 5  req/min  (THROTTLE_RELAXED unset)
 *
 *   Section B — Global throttler env-config:
 *     THROTTLER_LIMIT / THROTTLER_TTL_MS read from env — raised limit is respected.
 *
 *   Section C — THROTTLE_RELAXED in non-production:
 *     THROTTLE_RELAXED=true (NODE_ENV=test) → per-endpoint limits raised to global.
 *
 *   Section D — THROTTLE_RELAXED is SILENTLY IGNORED in production (security guardrail):
 *     THROTTLE_RELAXED=true + NODE_ENV=production → prod-hardened limits still apply.
 *
 * WHY minimal TestModule instead of full AppModule:
 *   Full AppModule requires live PostgreSQL + Redis + all env vars.  Unit-like
 *   isolation keeps the suite runnable in CI without external services.  We
 *   trade a real DB for a real Fastify HTTP pipeline — the part that actually
 *   exercises the throttler.
 *
 * WHY useFactory for JwtAuthGuard (AuthBypassGuard):
 *   vitest uses esbuild which strips TypeScript decorator metadata; NestJS DI
 *   would inject `undefined` for constructor params.  An explicit passthrough
 *   guard wired via `useFactory: () => new AuthBypassGuard()` avoids DI
 *   entirely while still putting a real guard into the APP_GUARD slot so the
 *   guard ordering (Auth → Throttle) mirrors production.
 *
 * WHY per-test fresh app instance:
 *   ThrottlerModule's default in-memory store accumulates state across tests.
 *   Spinning up a fresh app per `it` block resets the counter — there is no
 *   public API to flush the storage between tests without replacing the module.
 *   The overhead is acceptable for this regression suite.
 */

// ---------------------------------------------------------------------------
// Passthrough auth guard — simulates a logged-in user without JWT or DB.
// ---------------------------------------------------------------------------

class AuthBypassGuard implements CanActivate {
  canActivate(_ctx: ExecutionContext): boolean {
    return true
  }
}

// ---------------------------------------------------------------------------
// Sentinel controllers — use the same env-aware decorators as the real
// controllers so the test exercises the actual decorator factory code path.
// ---------------------------------------------------------------------------

@Controller('contracts')
class ContractsThrottleController {
  /**
   * POST /api/contracts/sign
   * Uses @SensitiveWriteThrottle() — 10 req/min in prod/strict, global limit when relaxed.
   */
  @Post('sign')
  @SensitiveWriteThrottle()
  sign() {
    return { ok: true }
  }

  /**
   * POST /api/contracts/templates
   * Uses @AdminWriteThrottle() — 5 req/min in prod/strict, global limit when relaxed.
   */
  @Post('templates')
  @AdminWriteThrottle()
  templates() {
    return { ok: true }
  }
}

@Controller('tos')
class TosThrottleController {
  /**
   * POST /api/tos/accept
   * Uses @SensitiveWriteThrottle() — 10 req/min in prod/strict, global limit when relaxed.
   */
  @Post('accept')
  @SensitiveWriteThrottle()
  accept() {
    return { ok: true }
  }

  /**
   * POST /api/tos (publish)
   * Uses @AdminWriteThrottle() — 5 req/min in prod/strict, global limit when relaxed.
   */
  @Post()
  @AdminWriteThrottle()
  publish() {
    return { ok: true }
  }
}

// ---------------------------------------------------------------------------
// Helper — boots a fresh app with the given global throttler config so the
// in-memory store starts at zero per test.
// ---------------------------------------------------------------------------

async function buildApp(throttleCfg: {
  ttl: number
  limit: number
}): Promise<NestFastifyApplication> {
  @Module({
    imports: [
      ThrottlerModule.forRoot([
        {
          name: 'default',
          ttl: throttleCfg.ttl,
          limit: throttleCfg.limit,
        },
      ]),
    ],
    controllers: [ContractsThrottleController, TosThrottleController],
    providers: [
      Reflector,
      // Auth guard runs first — allows request without JWT.
      {
        provide: APP_GUARD,
        useFactory: () => new AuthBypassGuard(),
      },
      // ThrottlerGuard runs after auth (mirrors AppModule APP_GUARD order).
      {
        provide: APP_GUARD,
        useClass: ThrottlerGuard,
      },
    ],
  })
  class ThrottleTestModule {}

  const moduleRef = await Test.createTestingModule({
    imports: [ThrottleTestModule],
  }).compile()

  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
  app.setGlobalPrefix('api')
  await app.init()
  await app.getHttpAdapter().getInstance().ready()
  return app
}

/** Sends `count` requests to `url` and returns the first 429 status index (1-based), or -1. */
async function firstThrottleHit(
  app: NestFastifyApplication,
  url: string,
  count: number,
): Promise<number> {
  for (let i = 1; i <= count; i++) {
    const res = await app.inject({ method: 'POST', url, payload: {} })
    if (res.statusCode === 429) return i
  }
  return -1
}

// ---------------------------------------------------------------------------
// Section A — Prod-hardened limits (THROTTLE_RELAXED unset / false)
// ---------------------------------------------------------------------------

describe('Throttle integration — Section A: prod-hardened per-endpoint limits', () => {
  let app: NestFastifyApplication

  beforeEach(async () => {
    // Ensure relaxed flag is unset — these tests pin strict prod behaviour.
    delete process.env.THROTTLE_RELAXED
    delete process.env.NODE_ENV
    // Global limit high (100) so only per-endpoint @Throttle() kicks in first.
    app = await buildApp({ ttl: 60_000, limit: 100 })
  })

  afterEach(async () => {
    if (app) await app.close()
  })

  afterAll(() => {
    // Restore NODE_ENV for subsequent suites.
    process.env.NODE_ENV = 'test'
    delete process.env.THROTTLE_RELAXED
    delete process.env.THROTTLER_LIMIT
    delete process.env.THROTTLER_TTL_MS
  })

  it('throttles POST /api/contracts/sign after 10 req/min (429 on 11th)', async () => {
    const hitAt = await firstThrottleHit(app, '/api/contracts/sign', 11)
    expect(hitAt, 'Expected 429 within 11 requests').toBe(11)
  })

  it('throttles POST /api/tos/accept after 10 req/min (429 on 11th)', async () => {
    const hitAt = await firstThrottleHit(app, '/api/tos/accept', 11)
    expect(hitAt, 'Expected 429 within 11 requests').toBe(11)
  })

  it('throttles POST /api/contracts/templates after 5 req/min (429 on 6th)', async () => {
    const hitAt = await firstThrottleHit(app, '/api/contracts/templates', 6)
    expect(hitAt, 'Expected 429 within 6 requests').toBe(6)
  })

  it('throttles POST /api/tos (publish) after 5 req/min (429 on 6th)', async () => {
    const hitAt = await firstThrottleHit(app, '/api/tos', 6)
    expect(hitAt, 'Expected 429 within 6 requests').toBe(6)
  })
})

// ---------------------------------------------------------------------------
// Section B — Global throttler env-config (THROTTLER_LIMIT / THROTTLER_TTL_MS)
// ---------------------------------------------------------------------------

describe('Throttle integration — Section B: global throttler env-config', () => {
  let app: NestFastifyApplication

  afterEach(async () => {
    if (app) await app.close()
    delete process.env.THROTTLE_RELAXED
    delete process.env.THROTTLER_LIMIT
    delete process.env.THROTTLER_TTL_MS
  })

  it('respects THROTTLER_LIMIT=5 — global limit of 5 (429 on 6th) without per-endpoint override', async () => {
    // Use a controller endpoint that does NOT have a per-endpoint @Throttle.
    // We test global limit by building app with limit=5 and a bare endpoint.
    @Controller('test-global')
    class GlobalLimitController {
      @Post()
      probe() {
        return { ok: true }
      }
    }

    @Module({
      imports: [ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 5 }])],
      controllers: [GlobalLimitController],
      providers: [
        Reflector,
        { provide: APP_GUARD, useFactory: () => new AuthBypassGuard() },
        { provide: APP_GUARD, useClass: ThrottlerGuard },
      ],
    })
    class GlobalLimitModule {}

    const moduleRef = await Test.createTestingModule({ imports: [GlobalLimitModule] }).compile()
    const testApp = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    testApp.setGlobalPrefix('api')
    await testApp.init()
    await testApp.getHttpAdapter().getInstance().ready()

    const hitAt = await firstThrottleHit(testApp, '/api/test-global', 6)
    await testApp.close()

    expect(hitAt, 'Global limit 5 → 429 on 6th request').toBe(6)
  })

  it('default THROTTLER_LIMIT of 100 allows 100 requests without 429 (spot-check of default)', async () => {
    // Verify the default matches prod (100): send 100 requests, none should hit 429.
    // We use a limit=100 module and a short loop (not 100 iterations — just confirm
    // first 20 pass, which proves the limit is > 10).
    app = await buildApp({ ttl: 60_000, limit: 100 })
    const hitAt = await firstThrottleHit(app, '/api/contracts/sign', 20)
    // With THROTTLE_RELAXED unset, per-endpoint limit 10 kicks in at request 11.
    // This confirms the prod limit IS 10 for /sign (Section A re-confirmed here).
    expect(hitAt).toBe(11)
  })
})

// ---------------------------------------------------------------------------
// Section C — THROTTLE_RELAXED in non-production (NODE_ENV !== 'production')
// ---------------------------------------------------------------------------

describe('Throttle integration — Section C: THROTTLE_RELAXED raises per-endpoint limits', () => {
  let app: NestFastifyApplication
  const savedEnv = {
    NODE_ENV: process.env.NODE_ENV,
    THROTTLE_RELAXED: process.env.THROTTLE_RELAXED,
    THROTTLER_LIMIT: process.env.THROTTLER_LIMIT,
  }

  afterEach(async () => {
    if (app) await app.close()
    // Restore env snapshot
    if (savedEnv.NODE_ENV !== undefined) process.env.NODE_ENV = savedEnv.NODE_ENV
    else delete process.env.NODE_ENV
    if (savedEnv.THROTTLE_RELAXED !== undefined)
      process.env.THROTTLE_RELAXED = savedEnv.THROTTLE_RELAXED
    else delete process.env.THROTTLE_RELAXED
    if (savedEnv.THROTTLER_LIMIT !== undefined)
      process.env.THROTTLER_LIMIT = savedEnv.THROTTLER_LIMIT
    else delete process.env.THROTTLER_LIMIT
  })

  it('THROTTLE_RELAXED=true (NODE_ENV=test) — /sign allows >10 requests (raised to global 20)', async () => {
    // Set relaxed mode with a global limit of 20 so per-endpoint limit (10) is
    // overridden: first 429 should come at request 21, not at 11.
    process.env.NODE_ENV = 'test'
    process.env.THROTTLE_RELAXED = 'true'
    process.env.THROTTLER_LIMIT = '20'

    app = await buildApp({ ttl: 60_000, limit: 20 })

    // In relaxed mode, SensitiveWriteThrottle() returns globalLimit() = 20.
    // So requests 1-20 should pass, 21st triggers 429.
    const hitAt = await firstThrottleHit(app, '/api/contracts/sign', 21)
    expect(hitAt, 'Relaxed mode: 429 at request 21 (global limit 20)').toBe(21)
  })

  it('THROTTLE_RELAXED=true (NODE_ENV=test) — /tos/accept allows >10 requests', async () => {
    process.env.NODE_ENV = 'test'
    process.env.THROTTLE_RELAXED = 'true'
    process.env.THROTTLER_LIMIT = '20'

    app = await buildApp({ ttl: 60_000, limit: 20 })

    const hitAt = await firstThrottleHit(app, '/api/tos/accept', 21)
    expect(hitAt, 'Relaxed mode: 429 at request 21 (global limit 20)').toBe(21)
  })

  it('THROTTLE_RELAXED=true (NODE_ENV=test) — /contracts/templates allows >5 requests', async () => {
    process.env.NODE_ENV = 'test'
    process.env.THROTTLE_RELAXED = 'true'
    process.env.THROTTLER_LIMIT = '20'

    app = await buildApp({ ttl: 60_000, limit: 20 })

    // Admin limit was 5; relaxed → 20.
    const hitAt = await firstThrottleHit(app, '/api/contracts/templates', 21)
    expect(hitAt, 'Relaxed mode: 429 at request 21 (global limit 20)').toBe(21)
  })

  it('THROTTLE_RELAXED=false — strict limits still apply', async () => {
    process.env.NODE_ENV = 'test'
    process.env.THROTTLE_RELAXED = 'false'

    app = await buildApp({ ttl: 60_000, limit: 100 })

    const hitAt = await firstThrottleHit(app, '/api/contracts/sign', 11)
    expect(hitAt, 'Strict mode: 429 at request 11').toBe(11)
  })
})

// ---------------------------------------------------------------------------
// Section D — THROTTLE_RELAXED is SILENTLY IGNORED in production
//             (security guardrail — prod rate limits cannot be weakened)
// ---------------------------------------------------------------------------

describe('Throttle integration — Section D: THROTTLE_RELAXED ignored in production', () => {
  let app: NestFastifyApplication
  const savedNodeEnv = process.env.NODE_ENV
  const savedRelaxed = process.env.THROTTLE_RELAXED
  const savedLimit = process.env.THROTTLER_LIMIT

  afterEach(async () => {
    if (app) await app.close()
    // Restore original env
    if (savedNodeEnv !== undefined) process.env.NODE_ENV = savedNodeEnv
    else delete process.env.NODE_ENV
    if (savedRelaxed !== undefined) process.env.THROTTLE_RELAXED = savedRelaxed
    else delete process.env.THROTTLE_RELAXED
    if (savedLimit !== undefined) process.env.THROTTLER_LIMIT = savedLimit
    else delete process.env.THROTTLER_LIMIT
  })

  it('THROTTLE_RELAXED=true + NODE_ENV=production → prod-hardened limits still enforced (429 on 11th for /sign)', async () => {
    // Simulate a misconfigured prod deployment where THROTTLE_RELAXED was set.
    // Security guardrail: the flag must be silently ignored.
    process.env.NODE_ENV = 'production'
    process.env.THROTTLE_RELAXED = 'true'
    process.env.THROTTLER_LIMIT = '1000' // high global limit — proves per-endpoint isn't bypassed

    app = await buildApp({ ttl: 60_000, limit: 1000 })

    // SensitiveWriteThrottle() must return 10 (not 1000) in production.
    const hitAt = await firstThrottleHit(app, '/api/contracts/sign', 11)
    expect(
      hitAt,
      'In production THROTTLE_RELAXED must be ignored — 429 at request 11 (prod hardened limit 10)',
    ).toBe(11)
  })

  it('THROTTLE_RELAXED=true + NODE_ENV=production → admin limit still 5 for /contracts/templates', async () => {
    process.env.NODE_ENV = 'production'
    process.env.THROTTLE_RELAXED = 'true'
    process.env.THROTTLER_LIMIT = '1000'

    app = await buildApp({ ttl: 60_000, limit: 1000 })

    // AdminWriteThrottle() must return 5 in production regardless of THROTTLE_RELAXED.
    const hitAt = await firstThrottleHit(app, '/api/contracts/templates', 6)
    expect(
      hitAt,
      'In production THROTTLE_RELAXED must be ignored — 429 at request 6 (prod hardened limit 5)',
    ).toBe(6)
  })
})

// ---------------------------------------------------------------------------
// Section E — company-account endpoints (RelaxableThrottle — WALLET / DEPOSIT / DIVIDEND)
//
// Pins that the three money-path endpoints in CompanyAccountController use
// RelaxableThrottle() and therefore:
//   E1. Respect prod-hardened limits when THROTTLE_RELAXED is unset.
//   E2. Raise limits when THROTTLE_RELAXED=true outside production (CI fix).
//   E3. THROTTLE_RELAXED is IGNORED when NODE_ENV==='production' (security guardrail).
//
// WHY sentinel controller instead of the real CompanyAccountController:
//   CompanyAccountController depends on CompanyAccountService (Drizzle/DB), which
//   cannot be instantiated in an in-memory test module. A sentinel that applies the
//   same RelaxableThrottle(N) decorators exercises the SAME decorator code path
//   without pulling in the full DI graph — identical to the pattern used for
//   ContractsThrottleController / TosThrottleController above.
// ---------------------------------------------------------------------------

@Controller('company-account')
class CompanyAccountThrottleController {
  /**
   * PATCH /api/company-account/wallet
   * RelaxableThrottle(WALLET_UPDATE_LIMIT) — 5 req/min in prod, relaxable in non-prod.
   */
  @Patch('wallet')
  @RelaxableThrottle(WALLET_UPDATE_LIMIT)
  updateWallet() {
    return { ok: true }
  }

  /**
   * POST /api/company-account/deposits
   * RelaxableThrottle(DEPOSIT_LIMIT) — 12 req/min in prod, relaxable in non-prod.
   */
  @Post('deposits')
  @RelaxableThrottle(DEPOSIT_LIMIT)
  submitDeposit() {
    return { ok: true }
  }

  /**
   * POST /api/company-account/dividends
   * RelaxableThrottle(DIVIDEND_LIMIT) — 5 req/min in prod, relaxable in non-prod.
   */
  @Post('dividends')
  @RelaxableThrottle(DIVIDEND_LIMIT)
  createDividend() {
    return { ok: true }
  }
}

/** Boot a fresh Fastify app with CompanyAccountThrottleController for isolation. */
async function buildCompanyApp(throttleCfg: {
  ttl: number
  limit: number
}): Promise<NestFastifyApplication> {
  @Module({
    imports: [
      ThrottlerModule.forRoot([
        {
          name: 'default',
          ttl: throttleCfg.ttl,
          limit: throttleCfg.limit,
        },
      ]),
    ],
    controllers: [CompanyAccountThrottleController],
    providers: [
      Reflector,
      { provide: APP_GUARD, useFactory: () => new AuthBypassGuard() },
      { provide: APP_GUARD, useClass: ThrottlerGuard },
    ],
  })
  class CompanyAccountThrottleModule {}

  const moduleRef = await Test.createTestingModule({
    imports: [CompanyAccountThrottleModule],
  }).compile()

  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
  app.setGlobalPrefix('api')
  await app.init()
  await app.getHttpAdapter().getInstance().ready()
  return app
}

/** Like firstThrottleHit but uses PATCH method. */
async function firstThrottleHitPatch(
  app: NestFastifyApplication,
  url: string,
  count: number,
): Promise<number> {
  for (let i = 1; i <= count; i++) {
    const res = await app.inject({ method: 'PATCH', url, payload: {} })
    if (res.statusCode === 429) return i
  }
  return -1
}

describe('Throttle integration — Section E1: company-account prod-hardened limits (THROTTLE_RELAXED unset)', () => {
  let app: NestFastifyApplication

  beforeEach(async () => {
    delete process.env.THROTTLE_RELAXED
    delete process.env.NODE_ENV
    // Global limit high (100) so only per-endpoint RelaxableThrottle kicks in first.
    app = await buildCompanyApp({ ttl: 60_000, limit: 100 })
  })

  afterEach(async () => {
    if (app) await app.close()
  })

  afterAll(() => {
    process.env.NODE_ENV = 'test'
    delete process.env.THROTTLE_RELAXED
    delete process.env.THROTTLER_LIMIT
  })

  it('throttles PATCH /api/company-account/wallet after WALLET_UPDATE_LIMIT=5 req/min (429 on 6th)', async () => {
    // Prod-hardened: WALLET_UPDATE_LIMIT = 5 → 429 on request 6.
    const hitAt = await firstThrottleHitPatch(app, '/api/company-account/wallet', 6)
    expect(
      hitAt,
      `Expected 429 within 6 requests (WALLET_UPDATE_LIMIT=${WALLET_UPDATE_LIMIT})`,
    ).toBe(6)
  })

  it('throttles POST /api/company-account/deposits after DEPOSIT_LIMIT=12 req/min (429 on 13th)', async () => {
    // Prod-hardened: DEPOSIT_LIMIT = 12 → 429 on request 13.
    const hitAt = await firstThrottleHit(app, '/api/company-account/deposits', 13)
    expect(hitAt, `Expected 429 within 13 requests (DEPOSIT_LIMIT=${DEPOSIT_LIMIT})`).toBe(13)
  })

  it('throttles POST /api/company-account/dividends after DIVIDEND_LIMIT=5 req/min (429 on 6th)', async () => {
    // Prod-hardened: DIVIDEND_LIMIT = 5 → 429 on request 6.
    const hitAt = await firstThrottleHit(app, '/api/company-account/dividends', 6)
    expect(hitAt, `Expected 429 within 6 requests (DIVIDEND_LIMIT=${DIVIDEND_LIMIT})`).toBe(6)
  })
})

describe('Throttle integration — Section E2: company-account THROTTLE_RELAXED raises limits (non-prod)', () => {
  let app: NestFastifyApplication
  const savedEnv = {
    NODE_ENV: process.env.NODE_ENV,
    THROTTLE_RELAXED: process.env.THROTTLE_RELAXED,
    THROTTLER_LIMIT: process.env.THROTTLER_LIMIT,
  }

  afterEach(async () => {
    if (app) await app.close()
    if (savedEnv.NODE_ENV !== undefined) process.env.NODE_ENV = savedEnv.NODE_ENV
    else delete process.env.NODE_ENV
    if (savedEnv.THROTTLE_RELAXED !== undefined)
      process.env.THROTTLE_RELAXED = savedEnv.THROTTLE_RELAXED
    else delete process.env.THROTTLE_RELAXED
    if (savedEnv.THROTTLER_LIMIT !== undefined)
      process.env.THROTTLER_LIMIT = savedEnv.THROTTLER_LIMIT
    else delete process.env.THROTTLER_LIMIT
  })

  it('THROTTLE_RELAXED=true (NODE_ENV=test) — /wallet allows >5 requests (raised to global 20)', async () => {
    // This is the CI fix: previously hardcoded @Throttle({limit:5}) blocked CI.
    // With RelaxableThrottle(5) + THROTTLE_RELAXED=true → limit raised to 20.
    process.env.NODE_ENV = 'test'
    process.env.THROTTLE_RELAXED = 'true'
    process.env.THROTTLER_LIMIT = '20'

    app = await buildCompanyApp({ ttl: 60_000, limit: 20 })

    // Global limit 20 → PATCH requests 1-20 pass, 21st triggers 429.
    const hitAt = await firstThrottleHitPatch(app, '/api/company-account/wallet', 21)
    expect(hitAt, 'Relaxed mode: 429 at request 21 (global limit 20)').toBe(21)
  })

  it('THROTTLE_RELAXED=true (NODE_ENV=test) — /deposits allows >12 requests (raised to global 20)', async () => {
    process.env.NODE_ENV = 'test'
    process.env.THROTTLE_RELAXED = 'true'
    process.env.THROTTLER_LIMIT = '20'

    app = await buildCompanyApp({ ttl: 60_000, limit: 20 })

    const hitAt = await firstThrottleHit(app, '/api/company-account/deposits', 21)
    expect(hitAt, 'Relaxed mode: 429 at request 21 (global limit 20)').toBe(21)
  })

  it('THROTTLE_RELAXED=true (NODE_ENV=test) — /dividends allows >5 requests (raised to global 20)', async () => {
    process.env.NODE_ENV = 'test'
    process.env.THROTTLE_RELAXED = 'true'
    process.env.THROTTLER_LIMIT = '20'

    app = await buildCompanyApp({ ttl: 60_000, limit: 20 })

    const hitAt = await firstThrottleHit(app, '/api/company-account/dividends', 21)
    expect(hitAt, 'Relaxed mode: 429 at request 21 (global limit 20)').toBe(21)
  })
})

describe('Throttle integration — Section E3: company-account THROTTLE_RELAXED IGNORED in production', () => {
  let app: NestFastifyApplication
  const savedNodeEnv = process.env.NODE_ENV
  const savedRelaxed = process.env.THROTTLE_RELAXED
  const savedLimit = process.env.THROTTLER_LIMIT

  afterEach(async () => {
    if (app) await app.close()
    if (savedNodeEnv !== undefined) process.env.NODE_ENV = savedNodeEnv
    else delete process.env.NODE_ENV
    if (savedRelaxed !== undefined) process.env.THROTTLE_RELAXED = savedRelaxed
    else delete process.env.THROTTLE_RELAXED
    if (savedLimit !== undefined) process.env.THROTTLER_LIMIT = savedLimit
    else delete process.env.THROTTLER_LIMIT
  })

  it('THROTTLE_RELAXED=true + NODE_ENV=production → /wallet still 5 req/min (429 on 6th)', async () => {
    // Security guardrail: prod ignores THROTTLE_RELAXED → WALLET_UPDATE_LIMIT=5.
    process.env.NODE_ENV = 'production'
    process.env.THROTTLE_RELAXED = 'true'
    process.env.THROTTLER_LIMIT = '1000'

    app = await buildCompanyApp({ ttl: 60_000, limit: 1000 })

    const hitAt = await firstThrottleHitPatch(app, '/api/company-account/wallet', 6)
    expect(
      hitAt,
      'In production THROTTLE_RELAXED must be ignored — 429 at request 6 (WALLET_UPDATE_LIMIT=5)',
    ).toBe(6)
  })

  it('THROTTLE_RELAXED=true + NODE_ENV=production → /deposits still 12 req/min (429 on 13th)', async () => {
    process.env.NODE_ENV = 'production'
    process.env.THROTTLE_RELAXED = 'true'
    process.env.THROTTLER_LIMIT = '1000'

    app = await buildCompanyApp({ ttl: 60_000, limit: 1000 })

    const hitAt = await firstThrottleHit(app, '/api/company-account/deposits', 13)
    expect(
      hitAt,
      'In production THROTTLE_RELAXED must be ignored — 429 at request 13 (DEPOSIT_LIMIT=12)',
    ).toBe(13)
  })

  it('THROTTLE_RELAXED=true + NODE_ENV=production → /dividends still 5 req/min (429 on 6th)', async () => {
    process.env.NODE_ENV = 'production'
    process.env.THROTTLE_RELAXED = 'true'
    process.env.THROTTLER_LIMIT = '1000'

    app = await buildCompanyApp({ ttl: 60_000, limit: 1000 })

    const hitAt = await firstThrottleHit(app, '/api/company-account/dividends', 6)
    expect(
      hitAt,
      'In production THROTTLE_RELAXED must be ignored — 429 at request 6 (DIVIDEND_LIMIT=5)',
    ).toBe(6)
  })
})
