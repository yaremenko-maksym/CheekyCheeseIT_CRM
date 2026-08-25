import { Controller, Module, Post } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler'
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { afterEach, describe, expect, it } from 'vitest'
import { THROTTLER_ERROR_MESSAGE } from './throttle-decorators'

/**
 * COPY-H-6 (copy-review, HIGH, PR #613 round 3).
 *
 * Pins the actual wire behaviour the bug was about: a rejected request past
 * the global limit must carry `THROTTLER_ERROR_MESSAGE` — Russian — in its
 * response body, not `@nestjs/throttler`'s own undocumented default
 * (`"ThrottlerException: Too Many Requests"`, English, and NOT one of
 * Nest's own generic HTTP reason phrases either — see that constant's own
 * doc in `throttle-decorators.ts`). The client's `extractBackendMessage`
 * (`apps/web/app/lib/axios-utils.ts`) reads `response.data.message` as a
 * genuine backend explanation whenever it is populated and not one of those
 * ~19 phrases — this is what proves the server no longer hands it the raw
 * English artifact.
 *
 * Plain `.spec.ts`, not `.integration.spec.ts` — no Postgres/Redis: this
 * boots an isolated Nest+Fastify app with ONLY `ThrottlerModule` and a bare
 * sentinel controller, the same pattern `contracts/throttle.integration.spec.ts`
 * uses for its per-endpoint suites (that file IS an integration spec only
 * because ITS sentinels sit alongside real per-endpoint decorators reused
 * from elsewhere in that describe block — this one needs none of that). Runs
 * under plain `pnpm test` / the pre-push gate, same as `app.module.spec.ts`.
 */

@Controller('probe')
class ThrottleMessageProbeController {
  @Post()
  probe() {
    return { ok: true }
  }
}

/**
 * Builds the app with the OBJECT-config shape `app.module.ts` now uses
 * (`{ throttlers: [...], errorMessage }`) — `@nestjs/throttler`'s own docs
 * are explicit that `errorMessage` is silently ignored under the bare-array
 * shape ("errorMessage won't work" with `ThrottlerModule.forRoot([...])`),
 * so a test against the array form would not catch a regression back to it.
 */
async function buildApp(limit: number): Promise<NestFastifyApplication> {
  @Module({
    imports: [
      ThrottlerModule.forRoot({
        throttlers: [{ name: 'default', ttl: 60_000, limit }],
        errorMessage: THROTTLER_ERROR_MESSAGE,
      }),
    ],
    controllers: [ThrottleMessageProbeController],
    providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
  })
  class ThrottleMessageProbeModule {}

  const moduleRef = await Test.createTestingModule({
    imports: [ThrottleMessageProbeModule],
  }).compile()

  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
  app.setGlobalPrefix('api')
  await app.init()
  await app.getHttpAdapter().getInstance().ready()
  return app
}

describe('ThrottlerModule errorMessage — COPY-H-6, the 429 body is Russian', () => {
  let app: NestFastifyApplication

  afterEach(async () => {
    if (app) await app.close()
  })

  it('a request past the limit gets THROTTLER_ERROR_MESSAGE verbatim in response.data.message', async () => {
    app = await buildApp(1)

    await app.inject({ method: 'POST', url: '/api/probe', payload: {} }) // consumes the only slot
    const rejected = await app.inject({ method: 'POST', url: '/api/probe', payload: {} })

    expect(rejected.statusCode).toBe(429)
    const body = rejected.json() as { message?: string }
    expect(body.message).toBe(THROTTLER_ERROR_MESSAGE)
  })

  it('the 429 body is NEVER the raw NestJS-throttler default English string', async () => {
    app = await buildApp(1)

    await app.inject({ method: 'POST', url: '/api/probe', payload: {} })
    const rejected = await app.inject({ method: 'POST', url: '/api/probe', payload: {} })

    const body = rejected.json() as { message?: string }
    expect(body.message).not.toContain('ThrottlerException')
    expect(body.message).not.toContain('Too Many Requests')
  })

  it('THROTTLER_ERROR_MESSAGE is itself Russian, not an echo of the NestJS default', () => {
    // A cheap guard against the constant regressing to the literal English
    // default by copy-paste — Cyrillic somewhere in the string is enough to
    // tell the two apart.
    expect(THROTTLER_ERROR_MESSAGE).toMatch(/[а-яё]/i)
    expect(THROTTLER_ERROR_MESSAGE).not.toBe('ThrottlerException: Too Many Requests')
  })
})
