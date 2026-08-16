import { CanActivate, Controller, ExecutionContext, Get, Module } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { ThrottlerModule } from '@nestjs/throttler'
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { afterEach, describe, expect, it } from 'vitest'
import { UserAwareThrottlerGuard } from './user-aware-throttler.guard'

/**
 * Backlog #52 — the global throttler used to track EVERY request by
 * `req.ip` alone (the `@nestjs/throttler` stock default), which means:
 *
 *   - two different AUTHENTICATED users behind the SAME address (office
 *     NAT, company VPN) shared one bucket;
 *   - one authenticated user switching address got a fresh bucket for free.
 *
 * `UserAwareThrottlerGuard` tracks by `req.user.id` when the auth guard
 * populated it, and only falls back to the IP for anonymous traffic.
 *
 * WHY A SENTINEL APP INSTEAD OF THE REAL AppModule:
 * Same reasoning as `contracts/throttle.integration.spec.ts` — a full
 * AppModule needs live Postgres/Redis and every env var. A minimal Fastify
 * app with the SAME guard class wired the SAME way (APP_GUARD, after an
 * auth stand-in) exercises the identical `getTracker` code path.
 *
 * `app.inject()` gives every request the SAME loopback address, which is
 * actually what makes this the right test: it reproduces "same office IP,
 * different people" without needing real sockets.
 */

/** Reads `x-test-user` and sets `req.user = { id }` — stands in for JwtAuthGuard. */
class SetUserFromHeaderGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest()
    const userId = req.headers['x-test-user']
    if (typeof userId === 'string' && userId.length > 0) {
      req.user = { id: userId }
    }
    return true
  }
}

@Controller('probe')
class ProbeController {
  @Get()
  ping() {
    return { ok: true }
  }
}

async function buildApp(limit: number): Promise<NestFastifyApplication> {
  @Module({
    imports: [ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit }])],
    controllers: [ProbeController],
    providers: [
      Reflector,
      { provide: APP_GUARD, useFactory: () => new SetUserFromHeaderGuard() },
      { provide: APP_GUARD, useClass: UserAwareThrottlerGuard },
    ],
  })
  class ProbeModule {}

  const moduleRef = await Test.createTestingModule({ imports: [ProbeModule] }).compile()
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
  app.setGlobalPrefix('api')
  await app.init()
  await app.getHttpAdapter().getInstance().ready()
  return app
}

/** Sends `count` requests, optionally as a given test-user, returns the first 429 index (1-based) or -1. */
async function firstThrottleHit(
  app: NestFastifyApplication,
  count: number,
  userId?: string,
): Promise<number> {
  for (let i = 1; i <= count; i++) {
    const res = await app.inject({
      method: 'GET',
      url: '/api/probe',
      headers: userId ? { 'x-test-user': userId } : {},
    })
    if (res.statusCode === 429) return i
  }
  return -1
}

describe('UserAwareThrottlerGuard (#52)', () => {
  let app: NestFastifyApplication

  afterEach(async () => {
    if (app) await app.close()
  })

  it('two DIFFERENT authenticated users behind the SAME address get INDEPENDENT budgets', async () => {
    app = await buildApp(3)

    // User A spends their whole budget — every request comes from the SAME
    // loopback address via app.inject(), simulating a shared office IP.
    const hitA = await firstThrottleHit(app, 3, 'user-a')
    expect(hitA, 'user A should not be throttled within their own limit').toBe(-1)

    // User B, same address, has NOT touched their budget yet. Under the old
    // IP-only tracker this would already be exhausted (shared bucket).
    const hitB = await firstThrottleHit(app, 3, 'user-b')
    expect(hitB, 'user B must get their OWN fresh budget, not share A’s').toBe(-1)
  })

  it('the SAME authenticated user is throttled after their own limit, regardless of address', async () => {
    app = await buildApp(3)
    const hitAt = await firstThrottleHit(app, 4, 'user-c')
    expect(hitAt, 'user C’s 4th request should hit their own limit of 3').toBe(4)
  })

  it('anonymous (unauthenticated) traffic still shares one IP-keyed bucket — fallback preserved', async () => {
    app = await buildApp(3)
    // No x-test-user header on any request — the stand-in auth guard never
    // sets req.user, so every request must fall back to the SAME IP bucket
    // and the limit must still bite exactly as it did before this fix.
    const hitAt = await firstThrottleHit(app, 4)
    expect(hitAt, 'anonymous traffic must still be throttled by address').toBe(4)
  })

  it('an authenticated user and anonymous traffic do NOT share a bucket', async () => {
    app = await buildApp(3)
    // Anonymous exhausts the IP bucket first.
    const hitAnon = await firstThrottleHit(app, 3)
    expect(hitAnon).toBe(-1)

    // An authenticated request from the SAME address must not inherit the
    // anonymous bucket's spend — it gets its own user-keyed bucket.
    const hitUser = await firstThrottleHit(app, 3, 'user-d')
    expect(hitUser, 'authenticated user must not share the anonymous IP bucket').toBe(-1)
  })
})
