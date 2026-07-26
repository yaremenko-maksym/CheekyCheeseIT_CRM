/**
 * Contact — real-backend integration spec (real Postgres, real Fastify HTTP
 * pipeline, real ThrottlerGuard, real TurnstileService against Cloudflare's
 * documented "always passes" dummy secret — same pattern as
 * `vacancies.integration.spec.ts`). `ResendMailerService` is STUBBED (no real
 * Resend key in CI — task AC2 explicitly allows "юнит/интеграционным тестом с
 * замоканным HTTP" when no real key is available) so this spec proves the
 * REAL SQL `WHERE role = 'ADMIN'` recipient lookup + the REAL rate-limiter +
 * the REAL honeypot/Turnstile HTTP pipeline (feedback_mocked_e2e_guards
 * lesson — a fully-mocked unit spec alone cannot prove any of those).
 *
 * Covers (task-landing-contact-and-hiring-strip.md):
 *   AC2 (partial) — real DB ADMIN-email lookup feeds the stubbed mailer's
 *     `to` list (the actual Resend HTTP call itself is unit-tested against a
 *     mocked `fetch` in `resend-mailer.service.spec.ts` — no real key here).
 *   AC3 — honeypot mimics 201 without ever calling the mailer; rate-limit
 *     429 on the real endpoint (own dedicated app instance — own throttle
 *     store, same pattern as vacancies.integration.spec.ts AC8).
 *   AC5 — 503 with the CONTACT_PUBLIC_EMAIL fallback when RESEND_API_KEY is
 *     unset (own dedicated app instance, no boot failure).
 *
 * DB-SKIP-GUARD: `dbAvailable = false` when DATABASE_URL is unreachable or
 * the `users` table is missing — every test bails early and stays green.
 *
 * Run against the scratch DB:
 *   pnpm --filter @crm/api exec vitest run contact.integration
 */
import { Global, Module } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { ConfigService } from '@nestjs/config'
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler'
import cookie from '@fastify/cookie'
import { drizzle } from 'drizzle-orm/node-postgres'
import { inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { DatabaseService } from '../database/database.service'
import { users } from '../database/schema'
import * as schema from '../database/schema'
import { TelemetryErrorsService } from '../telemetry/telemetry-errors.service'
import { TurnstileService } from '../vacancies/turnstile.service'
import { ZodExceptionFilter } from '../zod-exception.filter'
import { ContactController } from './contact.controller'
import { ContactService } from './contact.service'
import { ResendMailerService, type SendEmailInput } from './resend-mailer.service'

const NS = 'c1d2e3f4-a5b6-4003' // dedicated namespace for THIS spec — no collision
const TEST_ADMIN_EMAIL = `contact-integration-admin-${NS}@test.spec`
const TEST_ADMIN_ID = `${NS}-aa00-000000000001`
const TEST_USER_IDS = [TEST_ADMIN_ID]

const DUMMY_TURNSTILE_SECRET = '1x0000000000000000000000000000000AA'
const VALID_TURNSTILE_TOKEN = 'any-token-accepted-by-dummy-secret'

const VALID_BODY = {
  name: 'Ivan Petrenko',
  email: 'ivan@example.com',
  message: 'We would like to discuss a new project with your engineering team.',
  turnstileToken: VALID_TURNSTILE_TOKEN,
}

function fakeEnv(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    TURNSTILE_SECRET_KEY: DUMMY_TURNSTILE_SECRET,
    CONTACT_PUBLIC_EMAIL: 'hr@cheekycheese.tech',
    CONTACT_FROM_EMAIL: 'site@cheekycheese.tech',
    NODE_ENV: 'test',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// TestDatabaseModule — local closure pool per app instance (this spec builds
// THREE app instances: main, rate-limit-dedicated, no-key-dedicated — a
// shared file-level pool reference risks a cross-instance double `pool.end()`,
// same rationale as vacancies.integration.spec.ts).
// ---------------------------------------------------------------------------

let dbAvailable = true

@Global()
@Module({
  providers: [
    {
      provide: DatabaseService,
      useFactory: (): DatabaseService => {
        const pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
        const db = drizzle(pool, { schema })
        const instance = Object.create(DatabaseService.prototype) as DatabaseService
        Object.assign(instance, { pool, db })
        Object.defineProperty(instance, 'onModuleInit', {
          value: () => Promise.resolve(),
          writable: false,
          enumerable: false,
          configurable: true,
        })
        Object.defineProperty(instance, 'onModuleDestroy', {
          value: () => pool.end(),
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

/** A controllable stub — `isConfigured`/`send` are mutated per-test-module, never a real Resend call. */
function makeStubMailer(opts: { isConfigured?: boolean } = {}): ResendMailerService {
  const send = vi.fn(async (_input: SendEmailInput) => undefined)
  return { isConfigured: opts.isConfigured ?? true, send } as unknown as ResendMailerService
}

function buildContactTestModule(
  mailer: ResendMailerService,
  throttlerLimit: number,
  env: Record<string, unknown>,
) {
  const fakeConfigService = { get: (key: string) => env[key] } as unknown as ConfigService

  @Module({
    imports: [
      TestDatabaseModule,
      ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: throttlerLimit }]),
    ],
    controllers: [ContactController],
    providers: [
      Reflector,
      { provide: ConfigService, useValue: fakeConfigService },
      { provide: ResendMailerService, useValue: mailer },
      {
        provide: TurnstileService,
        useFactory: (c: ConfigService) => new TurnstileService(c),
        inject: [ConfigService],
      },
      {
        provide: TelemetryErrorsService,
        useFactory: (db: DatabaseService) => new TelemetryErrorsService(db),
        inject: [DatabaseService],
      },
      {
        provide: ContactService,
        useFactory: (
          db: DatabaseService,
          turnstile: TurnstileService,
          resendMailer: ResendMailerService,
          telemetry: TelemetryErrorsService,
          c: ConfigService,
        ) =>
          new ContactService(
            db,
            turnstile,
            resendMailer,
            telemetry,
            c as ConfigService<never, true>,
          ),
        inject: [
          DatabaseService,
          TurnstileService,
          ResendMailerService,
          TelemetryErrorsService,
          ConfigService,
        ],
      },
      { provide: APP_GUARD, useClass: ThrottlerGuard },
    ],
  })
  class ContactTestModule {}

  return ContactTestModule
}

async function buildApp(
  mailer: ResendMailerService,
  throttlerLimit = 1_000,
  env: Record<string, unknown> = fakeEnv(),
): Promise<NestFastifyApplication> {
  const TestModule = buildContactTestModule(mailer, throttlerLimit, env)
  const moduleRef = await Test.createTestingModule({ imports: [TestModule] }).compile()
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
  await app.register(cookie, { secret: 'contact-integration-cookie-secret' })
  app.setGlobalPrefix('api')
  app.useGlobalFilters(new ZodExceptionFilter())
  await app.init()
  await app.getHttpAdapter().getInstance().ready()
  return app
}

async function probeDb(): Promise<boolean> {
  try {
    const probePool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    await probePool.query('SELECT 1')
    const check = await probePool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_name='users' LIMIT 1`,
    )
    await probePool.end()
    return check.rowCount !== 0
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Contact — real backend integration', () => {
  let app: NestFastifyApplication
  let mailer: ResendMailerService
  let dbSvc: DatabaseService

  beforeAll(async () => {
    dbAvailable = await probeDb()
    if (!dbAvailable) {
      console.warn(
        '[contact integration] SKIPPED — no DB reachable at DATABASE_URL, or users table missing',
      )
      return
    }

    // Relax the REAL per-route @RelaxableThrottle(CONTACT_SUBMIT_LIMIT=3) for
    // every test EXCEPT the dedicated "AC3 — rate limit" describe block below
    // (which flips this back to unrelaxed for its own duration) — otherwise
    // the shared `app` instance's 4 non-rate-limit tests below would exhaust
    // the real 3/hour cap themselves and start seeing 429s instead of the
    // status code each test actually means to assert. `isRelaxed()`
    // (throttle-decorators.ts) reads `process.env.THROTTLE_RELAXED` directly,
    // not ConfigService — this is the only way to affect it from a test.
    process.env['THROTTLE_RELAXED'] = 'true'

    mailer = makeStubMailer()
    app = await buildApp(mailer)
    dbSvc = app.get(DatabaseService)

    await dbSvc.db
      .insert(users)
      .values({
        id: TEST_ADMIN_ID,
        email: TEST_ADMIN_EMAIL,
        displayName: 'Contact Integration Admin',
        role: 'ADMIN',
        googleId: `test-google-${TEST_ADMIN_ID}`,
      })
      .onConflictDoNothing()
  }, 30_000)

  afterAll(async () => {
    delete process.env['THROTTLE_RELAXED']
    if (!dbAvailable) return
    try {
      await dbSvc.db.delete(users).where(inArray(users.id, TEST_USER_IDS))
    } catch {
      // non-fatal cleanup failure — do not mask test results
    }
    await app.close()
  }, 20_000)

  it('honeypot: non-empty website field mimics 201 success WITHOUT calling the mailer', async () => {
    if (!dbAvailable) return
    const sendCallsBefore = (mailer.send as ReturnType<typeof vi.fn>).mock.calls.length
    const res = await app.inject({
      method: 'POST',
      url: '/api/public/contact',
      payload: { ...VALID_BODY, website: 'http://spam.example' },
    })
    expect(res.statusCode).toBe(201)
    expect((mailer.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(sendCallsBefore)
  })

  it('happy path: real ADMIN lookup feeds the stubbed mailer, replyTo = visitor email', async () => {
    if (!dbAvailable) return
    const res = await app.inject({
      method: 'POST',
      url: '/api/public/contact',
      payload: VALID_BODY,
    })
    expect(res.statusCode).toBe(201)

    const calls = (mailer.send as ReturnType<typeof vi.fn>).mock.calls
    const lastInput = calls[calls.length - 1]![0] as SendEmailInput
    expect(lastInput.to).toContain(TEST_ADMIN_EMAIL)
    expect(lastInput.replyTo).toBe(VALID_BODY.email)
    expect(lastInput.subject).toContain('Ivan Petrenko')
  })

  it('turnstile invalid token → 400 (real Cloudflare siteverify call against the dummy secret)', async () => {
    if (!dbAvailable) return
    // The dummy TURNSTILE_SECRET_KEY still requires a genuine round trip to
    // Cloudflare — an EMPTY response token is what a real browser sends when
    // the widget never completed, and Cloudflare rejects it regardless of
    // which secret verifies it.
    const res = await app.inject({
      method: 'POST',
      url: '/api/public/contact',
      payload: { ...VALID_BODY, turnstileToken: '' },
    })
    // Zod rejects the empty string before Turnstile is ever reached
    // (`turnstileToken: z.string().min(1)`).
    expect(res.statusCode).toBe(400)
  })

  it('malformed body (message too short) → 400 via ZodExceptionFilter', async () => {
    if (!dbAvailable) return
    const res = await app.inject({
      method: 'POST',
      url: '/api/public/contact',
      payload: { ...VALID_BODY, message: 'short' },
    })
    expect(res.statusCode).toBe(400)
  })

  // ── AC5 — no RESEND_API_KEY → 503 ────────────────────────────────────────

  describe('AC5 — Resend not configured', () => {
    it('responds 503 with the CONTACT_PUBLIC_EMAIL fallback, never calls the mailer', async () => {
      if (!dbAvailable) return
      const unconfiguredMailer = makeStubMailer({ isConfigured: false })
      const noKeyApp = await buildApp(unconfiguredMailer)
      try {
        const res = await noKeyApp.inject({
          method: 'POST',
          url: '/api/public/contact',
          payload: VALID_BODY,
        })
        expect(res.statusCode).toBe(503)
        expect(res.json()).toMatchObject({
          message: expect.stringContaining('hr@cheekycheese.tech'),
        })
        expect((unconfiguredMailer.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0)
      } finally {
        await noKeyApp.close()
      }
    }, 20_000)
  })

  // ── AC3 — rate limit (own dedicated app instance — own throttle store) ───

  describe('AC3 — rate limit', () => {
    it('returns 429 once CONTACT_SUBMIT_LIMIT is exceeded within the window', async () => {
      if (!dbAvailable) return
      // Un-relax for THIS test only (see the outer `beforeAll` comment) — the
      // real prod cap (CONTACT_SUBMIT_LIMIT=3, see contact.controller.ts)
      // must actually apply here; the module-level ThrottlerModule.forRoot
      // default is irrelevant, `@RelaxableThrottle` on the route overrides it
      // per-request whenever THROTTLE_RELAXED !== 'true'.
      const previousRelaxed = process.env['THROTTLE_RELAXED']
      process.env['THROTTLE_RELAXED'] = 'false'
      const rlMailer = makeStubMailer()
      const rlApp = await buildApp(rlMailer, 1_000)
      try {
        let hitAt = 0
        for (let i = 1; i <= 5; i++) {
          const res = await rlApp.inject({
            method: 'POST',
            url: '/api/public/contact',
            payload: { ...VALID_BODY, message: `rate-limit probe message #${i}` },
          })
          if (res.statusCode === 429) {
            hitAt = i
            break
          }
        }
        expect(hitAt, 'Expected 429 within 4 requests (CONTACT_SUBMIT_LIMIT=3)').toBe(4)
      } finally {
        await rlApp.close()
        process.env['THROTTLE_RELAXED'] = previousRelaxed
      }
    }, 20_000)
  })
})
