/**
 * Telemetry — real-backend integration spec (real Postgres, real Fastify
 * HTTP pipeline, real ThrottlerGuard/JwtAuthGuard/TelemetryDigestTokenGuard).
 *
 * WHY this spec exists (feedback_mocked_e2e_guards lesson): the unit specs
 * (telemetry-errors.service.spec.ts, telemetry-digest.service.spec.ts,
 * telemetry-exception.filter.spec.ts, ...) prove the ORCHESTRATION logic
 * against a mocked DB, but cannot prove the REAL upsert/regression semantics
 * (Postgres `ON CONFLICT DO UPDATE`), the REAL `percentile_cont`/`FILTER`
 * aggregate SQL, or the REAL rate-limiter. This spec drives the REAL
 * TelemetryController + TelemetryDigestController through a real Fastify
 * HTTP pipeline against a real Postgres.
 *
 * Covers (task-telemetry-api):
 *   AC2 — upsert grouping (3 identical errors → 1 row, count=3) +
 *         RESOLVED+repeat → NEW regression.
 *   AC4 — recursion guard (both branches: /api/telemetry/* never recorded;
 *         a normal route's 5xx IS recorded) through the real global filter.
 *   AC5 — digest: 401 without/with-wrong token; 200 + correct payload;
 *         idempotent NOTIFIED transition on repeat call; ux=1 aggregates
 *         against seeded telemetry_events.
 *   AC6 — rate-limit 429 on POST /api/telemetry/errors.
 *
 * DB-SKIP-GUARD: `dbAvailable = false` when DATABASE_URL is unreachable or
 * the telemetry_errors table is missing (CI unit job / DB not yet pushed) —
 * every test bails early and stays green (same pattern as
 * vacancies.integration.spec.ts).
 *
 * Run against the scratch DB:
 *   pnpm --filter @crm/api exec vitest run telemetry.integration
 * (`.env.test` injects DATABASE_URL=…crm_qa automatically for integration runs.)
 */
import { Controller, Get, Global, Module } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { ConfigService } from '@nestjs/config'
import { JwtModule, JwtService } from '@nestjs/jwt'
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler'
import cookie from '@fastify/cookie'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq, inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'

import { JwtAuthGuard } from '../auth/jwt.guard'
import { Public } from '../auth/public.decorator'
import type { Env } from '../config/env'
import { DatabaseService } from '../database/database.service'
import { telemetryErrors, telemetryEvents, users } from '../database/schema'
import * as schema from '../database/schema'
import { ZodExceptionFilter } from '../zod-exception.filter'
import { TelemetryController } from './telemetry.controller'
import { TelemetryDigestController } from './telemetry-digest.controller'
import { TelemetryDigestTokenGuard } from './telemetry-digest-token.guard'
import { TelemetryDigestService } from './telemetry-digest.service'
import { TelemetryErrorsService } from './telemetry-errors.service'
import { TelemetryEventsService } from './telemetry-events.service'
import { TelemetryExceptionFilter } from './telemetry-exception.filter'

const JWT_SECRET = 'telemetry-integration-secret-32-chars!!'
const DIGEST_TOKEN = 'telemetry-integration-real-digest-token-32chars!!'
const SESSION_SALT = 'telemetry-integration-real-session-salt-32chars!!'

// ---------------------------------------------------------------------------
// Test persona
// ---------------------------------------------------------------------------

const NS = 'b7c6d5e4-f301-4002' // dedicated namespace for THIS spec — no collision
const EMPLOYEE: SessionUser = {
  id: `${NS}-aa00-000000000001`,
  email: 'telemetry-integration-employee@test.spec',
  displayName: 'Telemetry Integration Employee',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}
const TEST_USER_IDS = [EMPLOYEE.id]

// ---------------------------------------------------------------------------
// Sentinel throw controllers (AC4) — test-only, never shipped to prod.
// Route path deliberately UNDER /api/telemetry/* for the "internal" one (so
// TelemetryExceptionFilter's recursion guard applies), and OUTSIDE it for
// the "normal route" control case.
// ---------------------------------------------------------------------------

@Controller('telemetry')
class TelemetryInternalThrowController {
  @Get('debug-throw-internal')
  debugThrowInternal(): never {
    throw new Error('artificial error INSIDE the telemetry module (AC4)')
  }
}

@Controller('debug')
class NormalRouteThrowController {
  @Public()
  @Get('debug-throw-normal')
  debugThrowNormal(): never {
    throw new Error('artificial error on a NORMAL route (AC4 control case)')
  }
}

// ---------------------------------------------------------------------------
// Fake ConfigService — only the keys telemetry code reads.
// ---------------------------------------------------------------------------

const fakeEnv: Record<string, unknown> = {
  TELEMETRY_DIGEST_TOKEN: DIGEST_TOKEN,
  TELEMETRY_SESSION_SALT: SESSION_SALT,
  NODE_ENV: 'test',
}
const fakeConfigService = { get: (key: string) => fakeEnv[key] } as unknown as ConfigService

// ---------------------------------------------------------------------------
// TestDatabaseModule — same pattern as vacancies.integration.spec.ts.
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

@Module({
  imports: [
    TestDatabaseModule,
    JwtModule.register({ secret: JWT_SECRET, signOptions: { expiresIn: '1h' } }),
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 1_000 }]),
  ],
  controllers: [
    TelemetryController,
    TelemetryDigestController,
    TelemetryInternalThrowController,
    NormalRouteThrowController,
  ],
  providers: [
    Reflector,
    { provide: ConfigService, useValue: fakeConfigService },
    {
      provide: TelemetryErrorsService,
      useFactory: (db: DatabaseService) => new TelemetryErrorsService(db),
      inject: [DatabaseService],
    },
    {
      provide: TelemetryEventsService,
      useFactory: (db: DatabaseService, c: ConfigService) => new TelemetryEventsService(db, c),
      inject: [DatabaseService, ConfigService],
    },
    {
      provide: TelemetryDigestService,
      useFactory: (db: DatabaseService) => new TelemetryDigestService(db),
      inject: [DatabaseService],
    },
    {
      provide: TelemetryDigestTokenGuard,
      useFactory: (c: ConfigService) => new TelemetryDigestTokenGuard(c),
      inject: [ConfigService],
    },
    // Bare-class registration (NOT useFactory) — TelemetryExceptionFilter
    // extends BaseExceptionFilter and relies on Nest's OWN property
    // injection populating the inherited `httpAdapterHost` field (lazy
    // resolution of the adapter — see that file's own doc comment for why).
    // Property injection only runs for instances NEST itself constructs;
    // a `useFactory` provider's manually-`new`'d return value never gets it,
    // which is the exact bug this integration spec caught and pinned.
    TelemetryExceptionFilter,
    {
      provide: APP_GUARD,
      useFactory: (jwtSvc: JwtService, reflector: Reflector) => new JwtAuthGuard(jwtSvc, reflector),
      inject: [JwtService, Reflector],
    },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
class TelemetryTestModule {}

async function buildApp(): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [TelemetryTestModule] })
    .overrideGuard(TelemetryDigestTokenGuard)
    .useValue(
      new TelemetryDigestTokenGuard(fakeConfigService as unknown as ConfigService<Env, true>),
    )
    .compile()
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
  await app.register(cookie, { secret: 'telemetry-integration-cookie-secret' })
  app.setGlobalPrefix('api')
  // Same registration ORDER as main.ts: catch-all TelemetryExceptionFilter
  // FIRST, ZodExceptionFilter second (see that file's own comment on why).
  app.useGlobalFilters(app.get(TelemetryExceptionFilter), new ZodExceptionFilter())
  await app.init()
  await app.getHttpAdapter().getInstance().ready()
  return app
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Telemetry — real backend integration', () => {
  let app: NestFastifyApplication
  let jwt: JwtService
  let dbSvc: DatabaseService

  function tokenFor(user: SessionUser): string {
    return jwt.sign(user)
  }

  beforeAll(async () => {
    try {
      const probePool = new Pool({ connectionString: process.env['DATABASE_URL'] })
      await probePool.query('SELECT 1')
      const check = await probePool.query(
        `SELECT table_name FROM information_schema.tables WHERE table_name='telemetry_errors' LIMIT 1`,
      )
      await probePool.end()
      if (check.rowCount === 0) {
        console.warn(
          '[telemetry integration] SKIPPED — telemetry_errors table not found (run db:push)',
        )
        dbAvailable = false
        return
      }
    } catch {
      console.warn('[telemetry integration] SKIPPED — no DB reachable at DATABASE_URL')
      dbAvailable = false
      return
    }

    app = await buildApp()
    jwt = app.get(JwtService)
    dbSvc = app.get(DatabaseService)

    await dbSvc.db
      .insert(users)
      .values({
        id: EMPLOYEE.id,
        email: EMPLOYEE.email,
        displayName: EMPLOYEE.displayName,
        role: 'SENIOR',
        googleId: `test-google-${EMPLOYEE.id}`,
      })
      .onConflictDoNothing()

    // Fresh slate for THIS spec — these two tables are exclusively owned by
    // it (no other spec/seed writes to them), so a truncate is safe and
    // simpler than per-row ID tracking.
    await dbSvc.db.execute('TRUNCATE TABLE telemetry_events, telemetry_errors RESTART IDENTITY')
  }, 30_000)

  afterAll(async () => {
    if (!dbAvailable) return
    try {
      await dbSvc.db.execute('TRUNCATE TABLE telemetry_events, telemetry_errors RESTART IDENTITY')
      await dbSvc.db.delete(users).where(inArray(users.id, TEST_USER_IDS))
    } catch {
      // non-fatal cleanup failure — do not mask test results
    }
    await app.close()
  }, 20_000)

  // ── AC2 — upsert grouping + regression ────────────────────────────────────

  describe('AC2 — upsert grouping + RESOLVED→NEW regression', () => {
    it('3 identical error reports → 1 row, count=3', async () => {
      if (!dbAvailable) return
      const payload = { message: `AC2 dedup test ${Date.now()}`, route: '/finance' }

      for (let i = 0; i < 3; i++) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/telemetry/errors',
          cookies: { jwt: tokenFor(EMPLOYEE) },
          payload,
        })
        expect(res.statusCode).toBe(204)
      }

      const rows = await dbSvc.db.query.telemetryErrors.findMany({
        where: (e, { eq: eqOp }) => eqOp(e.message, payload.message),
      })
      expect(rows).toHaveLength(1)
      expect(rows[0]!.count).toBe(3)
      expect(rows[0]!.status).toBe('NEW')
    })

    it('RESOLVED + repeat → flips back to NEW (regression)', async () => {
      if (!dbAvailable) return
      const message = `AC2 regression test ${Date.now()}`

      await app.inject({
        method: 'POST',
        url: '/api/telemetry/errors',
        cookies: { jwt: tokenFor(EMPLOYEE) },
        payload: { message },
      })

      await dbSvc.db
        .update(telemetryErrors)
        .set({ status: 'RESOLVED' })
        .where(eq(telemetryErrors.message, message))

      await app.inject({
        method: 'POST',
        url: '/api/telemetry/errors',
        cookies: { jwt: tokenFor(EMPLOYEE) },
        payload: { message },
      })

      const row = await dbSvc.db.query.telemetryErrors.findFirst({
        where: (e, { eq: eqOp }) => eqOp(e.message, message),
      })
      expect(row?.status).toBe('NEW')
      expect(row?.count).toBe(2)
    })
  })

  // ── AC4 — recursion guard (real HTTP pipeline) ─────────────────────────────

  describe('AC4 — recursion guard', () => {
    it('an artificial error INSIDE /api/telemetry/* does NOT create a telemetry_errors row, and still returns a normal 5xx response', async () => {
      if (!dbAvailable) return
      const [{ count: before }] = await dbSvc.db
        .execute<{ count: string }>('SELECT count(*)::text AS count FROM telemetry_errors')
        .then((r) => r.rows as { count: string }[])

      const res = await app.inject({
        method: 'GET',
        url: '/api/telemetry/debug-throw-internal',
        cookies: { jwt: tokenFor(EMPLOYEE) },
      })

      expect(res.statusCode).toBe(500)
      // Must be the REAL BaseExceptionFilter generic-unknown-error body, not
      // a secondary crash inside the filter itself (e.g. a stale/undefined
      // httpAdapter) masquerading as "500" — both look like 500 to a bare
      // status-code assertion, so this pins the actual message too.
      expect(res.json()).toMatchObject({ statusCode: 500 })
      expect(res.body).not.toContain('isHeadersSent')

      const [{ count: after }] = await dbSvc.db
        .execute<{ count: string }>('SELECT count(*)::text AS count FROM telemetry_errors')
        .then((r) => r.rows as { count: string }[])
      expect(after).toBe(before)
    })

    it('an artificial error on a NORMAL (non-telemetry) route DOES create a telemetry_errors row', async () => {
      if (!dbAvailable) return
      const res = await app.inject({ method: 'GET', url: '/api/debug/debug-throw-normal' })

      expect(res.statusCode).toBe(500)

      const row = await dbSvc.db.query.telemetryErrors.findFirst({
        where: (e, { eq: eqOp }) =>
          eqOp(e.message, 'artificial error on a NORMAL route (AC4 control case)'),
      })
      expect(row).toBeDefined()
      expect(row?.route).toBe('/api/debug/debug-throw-normal')
    })
  })

  // ── AC5 — digest ────────────────────────────────────────────────────────

  describe('AC5 — digest', () => {
    it('401 without a token', async () => {
      if (!dbAvailable) return
      const res = await app.inject({
        method: 'GET',
        url: `/api/telemetry/digest?since=${encodeURIComponent(new Date(0).toISOString())}`,
      })
      expect(res.statusCode).toBe(401)
    })

    it('401 with a wrong token', async () => {
      if (!dbAvailable) return
      const res = await app.inject({
        method: 'GET',
        url: `/api/telemetry/digest?since=${encodeURIComponent(new Date(0).toISOString())}`,
        headers: { 'x-telemetry-token': 'totally-wrong-token' },
      })
      expect(res.statusCode).toBe(401)
    })

    it('200 with the real token — returns a NEW error created earlier, then a repeat call with the same since does NOT duplicate it', async () => {
      if (!dbAvailable) return
      const message = `AC5 digest test ${Date.now()}`
      await app.inject({
        method: 'POST',
        url: '/api/telemetry/errors',
        cookies: { jwt: tokenFor(EMPLOYEE) },
        payload: { message },
      })

      const since = new Date(0).toISOString()
      const first = await app.inject({
        method: 'GET',
        url: `/api/telemetry/digest?since=${encodeURIComponent(since)}`,
        headers: { 'x-telemetry-token': DIGEST_TOKEN },
      })
      expect(first.statusCode).toBe(200)
      const firstBody = first.json() as { errors: { message: string; status: string }[] }
      expect(firstBody.errors.some((e) => e.message === message)).toBe(true)
      expect(firstBody.errors.find((e) => e.message === message)?.status).toBe('NEW')

      // Row is now NOTIFIED — a repeat call with the SAME since must not return it again.
      const second = await app.inject({
        method: 'GET',
        url: `/api/telemetry/digest?since=${encodeURIComponent(since)}`,
        headers: { 'x-telemetry-token': DIGEST_TOKEN },
      })
      expect(second.statusCode).toBe(200)
      const secondBody = second.json() as { errors: { message: string }[] }
      expect(secondBody.errors.some((e) => e.message === message)).toBe(false)

      const row = await dbSvc.db.query.telemetryErrors.findFirst({
        where: (e, { eq: eqOp }) => eqOp(e.message, message),
      })
      expect(row?.status).toBe('NOTIFIED')
    })

    it('ux=1 returns UX aggregates computed from seeded telemetry_events', async () => {
      if (!dbAvailable) return
      const route = `/ux-test-route-${Date.now()}`
      const target = `ux-test-target-${Date.now()}`

      await dbSvc.db.insert(telemetryEvents).values([
        { sessionHash: 'hash-1', userRole: 'SENIOR', event: 'route_enter', route },
        {
          sessionHash: 'hash-1',
          userRole: 'SENIOR',
          event: 'route_leave',
          route,
          durationMs: 1000,
        },
        { sessionHash: 'hash-2', userRole: 'SENIOR', event: 'route_enter', route },
        {
          sessionHash: 'hash-2',
          userRole: 'SENIOR',
          event: 'route_leave',
          route,
          durationMs: 3000,
        },
        { sessionHash: 'hash-1', userRole: 'SENIOR', event: 'feature_click', route, target },
        { sessionHash: 'hash-1', userRole: 'SENIOR', event: 'feature_click', route, target },
        { sessionHash: 'hash-1', userRole: 'SENIOR', event: 'form_abandon', route },
        { sessionHash: 'hash-2', userRole: 'SENIOR', event: 'form_submit', route },
        { sessionHash: 'hash-2', userRole: 'SENIOR', event: 'form_submit', route },
      ])

      const res = await app.inject({
        method: 'GET',
        url: `/api/telemetry/digest?since=${encodeURIComponent(new Date(0).toISOString())}&ux=1`,
        headers: { 'x-telemetry-token': DIGEST_TOKEN },
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as {
        ux: {
          topRoutesByRole: {
            role: string
            route: string
            visits: number
            medianDurationMs: number | null
          }[]
          featureClicks: { target: string; count: number }[]
          formAbandonRates: {
            route: string
            abandonCount: number
            submitCount: number
            abandonRate: number
          }[]
          medianDurations: { route: string; medianDurationMs: number }[]
        }
      }

      const topRoute = body.ux.topRoutesByRole.find((r) => r.route === route)
      expect(topRoute).toMatchObject({ role: 'SENIOR', visits: 2, medianDurationMs: 2000 })

      const clicks = body.ux.featureClicks.find((c) => c.target === target)
      expect(clicks).toMatchObject({ target, count: 2 })

      const abandonRate = body.ux.formAbandonRates.find((r) => r.route === route)
      expect(abandonRate).toMatchObject({ route, abandonCount: 1, submitCount: 2 })
      expect(abandonRate?.abandonRate).toBeCloseTo(1 / 3, 5)

      const median = body.ux.medianDurations.find((m) => m.route === route)
      expect(median).toMatchObject({ route, medianDurationMs: 2000 })
    })
  })

  // ── AC6 — rate-limit 429 ────────────────────────────────────────────────

  describe('AC6 — rate limit', () => {
    it('POST /api/telemetry/errors — 11th request within the window is 429', async () => {
      if (!dbAvailable) return
      let lastStatus = 0
      for (let i = 0; i < 11; i++) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/telemetry/errors',
          cookies: { jwt: tokenFor(EMPLOYEE) },
          payload: { message: `AC6 rate-limit test ${i} ${Date.now()}` },
        })
        lastStatus = res.statusCode
      }
      expect(lastStatus).toBe(429)
    })
  })
})
