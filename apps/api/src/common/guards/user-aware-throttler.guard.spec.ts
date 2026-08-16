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
 * `app.inject({ remoteAddress })` (light-my-request) lets a test choose the
 * simulated source address per request — used below both to reproduce "same
 * office IP, different people" (all requests share the DEFAULT address) and
 * to prove the IP fallback genuinely reads `req.ip` rather than returning a
 * constant (two DIFFERENT addresses).
 */

/**
 * Stands in for `JwtAuthGuard`. Reads `x-test-user` (a string → normal
 * authenticated id) or `x-test-user-id-json` (a JSON-encoded value — used to
 * hand the guard a non-string / empty id, the two invalid shapes
 * `getTracker`'s own checks exist to reject).
 */
class SetUserFromHeaderGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest()
    const raw = req.headers['x-test-user-id-json']
    if (typeof raw === 'string') {
      req.user = { id: JSON.parse(raw) }
      return true
    }
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

interface ProbeOptions {
  /** String user id — sets `req.user = { id: userId }`, the normal case. */
  userId?: string
  /** Raw (possibly invalid) `id` value, JSON-encoded — bypasses the string check entirely. */
  rawUserId?: unknown
  /** Simulated source address (light-my-request). Defaults to its own default when omitted. */
  remoteAddress?: string
}

/** Sends `count` requests per `opts`, returns the first 429 index (1-based) or -1. */
async function firstThrottleHit(
  app: NestFastifyApplication,
  count: number,
  opts: ProbeOptions = {},
): Promise<number> {
  const headers: Record<string, string> = {}
  if (opts.userId) headers['x-test-user'] = opts.userId
  if ('rawUserId' in opts) headers['x-test-user-id-json'] = JSON.stringify(opts.rawUserId)

  for (let i = 1; i <= count; i++) {
    const res = await app.inject({
      method: 'GET',
      url: '/api/probe',
      headers,
      ...(opts.remoteAddress ? { remoteAddress: opts.remoteAddress } : {}),
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
    // (default) address, simulating a shared office IP.
    const hitA = await firstThrottleHit(app, 3, { userId: 'user-a' })
    expect(hitA, 'user A should not be throttled within their own limit').toBe(-1)

    // User B, same address, has NOT touched their budget yet. Under the old
    // IP-only tracker this would already be exhausted (shared bucket).
    const hitB = await firstThrottleHit(app, 3, { userId: 'user-b' })
    expect(hitB, 'user B must get their OWN fresh budget, not share A’s').toBe(-1)
  })

  it('the SAME authenticated user is throttled after their own limit, regardless of address', async () => {
    app = await buildApp(3)
    const hitAt = await firstThrottleHit(app, 4, { userId: 'user-c' })
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
    const hitUser = await firstThrottleHit(app, 3, { userId: 'user-d' })
    expect(hitUser, 'authenticated user must not share the anonymous IP bucket').toBe(-1)
  })

  it('two DIFFERENT anonymous addresses get INDEPENDENT IP buckets — the fallback reads req.ip, not a constant', async () => {
    app = await buildApp(3)
    // Exhausts address #1's bucket.
    const hitFirst = await firstThrottleHit(app, 3, { remoteAddress: '10.0.0.1' })
    expect(hitFirst).toBe(-1)

    // A DIFFERENT address must not inherit that spend. If getTracker's IP
    // fallback ever collapsed to a constant (e.g. an empty string, or
    // `req.ip && ''`), every address would land in the SAME bucket and this
    // would incorrectly throttle here too.
    const hitSecond = await firstThrottleHit(app, 3, { remoteAddress: '10.0.0.2' })
    expect(hitSecond, 'a different source address must get its own IP bucket').toBe(-1)
  })

  it('the SAME anonymous address is still throttled after its own limit — the fallback is not empty/constant', async () => {
    app = await buildApp(3)
    const hitAt = await firstThrottleHit(app, 4, { remoteAddress: '10.0.0.3' })
    expect(hitAt, 'repeating the SAME address must still hit the shared limit on request 4').toBe(4)
  })

  it('a NON-STRING user.id is rejected by the type guard and falls back to the IP bucket', async () => {
    app = await buildApp(3)
    // An array is what `typeof user.id === 'string'` exists to reject — and
    // it is chosen deliberately over e.g. a plain number: a number has no
    // `.length`, so `.length > 0` would ALSO reject it on its own, which
    // would leave the `typeof` check's own mutant (replaced by `true`)
    // unobserved. An array has a real `.length`, so only the `typeof` guard
    // stands between it and being accepted as an id.
    const arrayAndAnon = await firstThrottleHit(app, 2, { rawUserId: [1, 2, 3] })
    expect(arrayAndAnon).toBe(-1)

    // Genuinely anonymous traffic from the SAME address must share that
    // SAME bucket (2 already spent) — one more request trips the limit of 3.
    const hitAt = await firstThrottleHit(app, 2)
    expect(
      hitAt,
      'a non-string id must not have created its own bucket — anonymous traffic shares it',
    ).toBe(2)
  })

  it('an EMPTY STRING user.id is rejected by the length guard and falls back to the IP bucket', async () => {
    app = await buildApp(3)
    // Mutating `.length > 0` to `.length >= 0` would accept this.
    const emptyAndAnon = await firstThrottleHit(app, 2, { rawUserId: '' })
    expect(emptyAndAnon).toBe(-1)

    const hitAt = await firstThrottleHit(app, 2)
    expect(
      hitAt,
      'an empty id must not have created its own bucket — anonymous traffic shares it',
    ).toBe(2)
  })
})
