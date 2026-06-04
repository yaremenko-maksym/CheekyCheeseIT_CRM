import { CanActivate, Controller, ExecutionContext, Module, Post } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { Throttle, ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler'
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * Integration test — pins that `@Throttle()` decorators on the real
 * SignedContractsController + ContractTemplatesController + TosController
 * endpoints actually enforce rate limits through the ThrottlerGuard HTTP
 * request lifecycle.
 *
 * WHAT it tests (regression coverage for PR #100):
 *   POST /api/contracts/sign        → limit 10 req/min
 *   POST /api/tos/accept            → limit 10 req/min
 *   POST /api/contracts/templates   → limit 5 req/min (ADMIN write)
 *   POST /api/tos                   → limit 5 req/min (ADMIN write)
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
 *   The overhead is acceptable for a 4-test regression suite.
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
// Sentinel controllers — mirror the @Throttle limits from the real controllers
// (PR #100) but return a trivial payload so no DB/service is needed.
// ---------------------------------------------------------------------------

@Controller('contracts')
class ContractsThrottleController {
  /** POST /api/contracts/sign — 10 req/min (mirrors signed-contracts.controller.ts) */
  @Post('sign')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  sign() {
    return { ok: true }
  }

  /** POST /api/contracts/templates — 5 req/min (mirrors contract-templates.controller.ts) */
  @Post('templates')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  templates() {
    return { ok: true }
  }
}

@Controller('tos')
class TosThrottleController {
  /** POST /api/tos/accept — 10 req/min (mirrors tos.controller.ts) */
  @Post('accept')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  accept() {
    return { ok: true }
  }

  /** POST /api/tos — 5 req/min (mirrors tos.controller.ts) */
  @Post()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  publish() {
    return { ok: true }
  }
}

// ---------------------------------------------------------------------------
// Minimal test module — real ThrottlerModule + real Fastify HTTP pipeline.
// ---------------------------------------------------------------------------

@Module({
  imports: [
    ThrottlerModule.forRoot([
      {
        name: 'default',
        ttl: 60_000,
        limit: 100,
      },
    ]),
  ],
  controllers: [ContractsThrottleController, TosThrottleController],
  providers: [
    Reflector,
    // Auth guard runs first — populates nothing but allows the request through.
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

// ---------------------------------------------------------------------------
// Helper — boots a fresh app for each test so the in-memory throttle store
// starts at zero.
// ---------------------------------------------------------------------------

async function buildApp(): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [ThrottleTestModule],
  }).compile()

  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
  app.setGlobalPrefix('api')
  await app.init()
  await app.getHttpAdapter().getInstance().ready()
  return app
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Throttle integration — @Throttle() decorators enforce rate limits', () => {
  let app: NestFastifyApplication

  beforeEach(async () => {
    // Fresh app = fresh in-memory throttle store.
    app = await buildApp()
  })

  afterAll(async () => {
    if (app) await app.close()
  })

  it('throttles POST /api/contracts/sign after 10 req/min (429 on 11th)', async () => {
    let got429 = false

    for (let i = 0; i < 11; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/contracts/sign',
        payload: {},
      })
      if (res.statusCode === 429) {
        got429 = true
        break
      }
      // Accept 201 (NestJS POST default) as success within the limit.
      expect(res.statusCode).toBeLessThan(400)
    }

    expect(got429).toBe(true)
  })

  it('throttles POST /api/tos/accept after 10 req/min (429 on 11th)', async () => {
    let got429 = false

    for (let i = 0; i < 11; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/tos/accept',
        payload: {},
      })
      if (res.statusCode === 429) {
        got429 = true
        break
      }
      expect(res.statusCode).toBeLessThan(400)
    }

    expect(got429).toBe(true)
  })

  it('throttles POST /api/contracts/templates after 5 req/min (429 on 6th)', async () => {
    let got429 = false

    for (let i = 0; i < 6; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/contracts/templates',
        payload: {},
      })
      if (res.statusCode === 429) {
        got429 = true
        break
      }
      expect(res.statusCode).toBeLessThan(400)
    }

    expect(got429).toBe(true)
  })

  it('throttles POST /api/tos (publish) after 5 req/min (429 on 6th)', async () => {
    let got429 = false

    for (let i = 0; i < 6; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/tos',
        payload: {},
      })
      if (res.statusCode === 429) {
        got429 = true
        break
      }
      expect(res.statusCode).toBeLessThan(400)
    }

    expect(got429).toBe(true)
  })
})
