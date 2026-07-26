/**
 * CSP Reports — real-backend integration spec (real Postgres, real Fastify
 * HTTP pipeline, real ThrottlerGuard, real custom content-type parser).
 * Same pattern as `telemetry.integration.spec.ts` / `contact.integration.spec.ts`.
 *
 * Covers (task-csp-reports-and-flip §Часть A item 6 + security round 1):
 *   AC2 — both Content-Types accepted (application/csp-report,
 *         application/reports+json); garbage body → 204, no record;
 *         rate-limit 429 once CSP_REPORT_LIMIT (60/hour) is exceeded.
 *   AC3 — dedup: 3 identical reports → 1 row, count=3.
 *   AC4 — a recorded violation is visible in GET /api/telemetry/digest's
 *         `cspViolations` section (+ `cspViolationsTotal`).
 *   Security round 1:
 *     HIGH-1d — a document-uri from a FOREIGN origin is dropped (the
 *       mass-reflection vector).
 *     HIGH-1e — a batch over the 10-item cap is rejected wholesale.
 *     LOW — a body over the 32 KB parser-level limit is rejected (413).
 *     MED-3 — a REAL write failure (not garbage input) still responds 204,
 *       but is recorded into `telemetry_errors` with a FIXED message.
 *
 * DB-SKIP-GUARD: `dbAvailable = false` when DATABASE_URL is unreachable or
 * the `csp_reports` table is missing — every test bails early and stays
 * green (same pattern as telemetry.integration.spec.ts).
 *
 * Run against the scratch DB:
 *   pnpm --filter @crm/api exec vitest run csp-reports.integration
 * (`.env.test` injects DATABASE_URL=…crm_qa automatically for integration runs.)
 */
import { Global, Module } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { ConfigService } from '@nestjs/config'
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import type { Env } from '../config/env'
import { DatabaseService } from '../database/database.service'
import * as schema from '../database/schema'
import { telemetryErrors } from '../database/schema'
import { TelemetryDigestTokenGuard } from '../telemetry/telemetry-digest-token.guard'
import { TelemetryDigestController } from '../telemetry/telemetry-digest.controller'
import { TelemetryDigestService } from '../telemetry/telemetry-digest.service'
import { TelemetryErrorsService } from '../telemetry/telemetry-errors.service'
import { ZodExceptionFilter } from '../zod-exception.filter'
import { registerCspReportContentTypeParser } from './csp-report-content-type-parser'
import { CspReportsController } from './csp-reports.controller'
import { CspReportsService } from './csp-reports.service'

const DIGEST_TOKEN = 'csp-reports-integration-real-digest-token-32chars!!'
/** Matches `FRONTEND_URL` below — every well-formed test payload's `document-uri` must be on THIS origin (HIGH-1d). */
const OUR_ORIGIN = 'https://app.cheekycheese.tech'
const INGEST_FAILURE_MESSAGE = 'csp-reports: write to csp_reports failed'

// ---------------------------------------------------------------------------
// TestDatabaseModule — same closure-pool-per-app pattern as
// contact.integration.spec.ts / telemetry.integration.spec.ts (this spec
// builds TWO app instances: main + a rate-limit-dedicated one).
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

function fakeEnv(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    TELEMETRY_DIGEST_TOKEN: DIGEST_TOKEN,
    FRONTEND_URL: OUR_ORIGIN,
    CORS_ORIGINS: undefined,
    NODE_ENV: 'test',
    ...overrides,
  }
}

function buildCspReportsTestModule(throttlerLimit: number, env: Record<string, unknown>) {
  const fakeConfigService = { get: (key: string) => env[key] } as unknown as ConfigService

  @Module({
    imports: [
      TestDatabaseModule,
      ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: throttlerLimit }]),
    ],
    controllers: [CspReportsController, TelemetryDigestController],
    providers: [
      Reflector,
      { provide: ConfigService, useValue: fakeConfigService },
      {
        provide: CspReportsService,
        useFactory: (db: DatabaseService, c: ConfigService) =>
          new CspReportsService(db, c as ConfigService<Env, true>),
        inject: [DatabaseService, ConfigService],
      },
      {
        provide: TelemetryErrorsService,
        useFactory: (db: DatabaseService) => new TelemetryErrorsService(db),
        inject: [DatabaseService],
      },
      {
        provide: TelemetryDigestService,
        useFactory: (db: DatabaseService) => new TelemetryDigestService(db),
        inject: [DatabaseService],
      },
      { provide: APP_GUARD, useClass: ThrottlerGuard },
    ],
  })
  class CspReportsTestModule {}

  return { CspReportsTestModule, fakeConfigService }
}

async function buildApp(
  throttlerLimit = 1_000,
  env: Record<string, unknown> = fakeEnv(),
): Promise<NestFastifyApplication> {
  const { CspReportsTestModule: TestModule, fakeConfigService } = buildCspReportsTestModule(
    throttlerLimit,
    env,
  )
  // `TelemetryDigestTokenGuard` is applied via `@UseGuards(TelemetryDigestTokenGuard)`
  // (a class reference, per-method) on the REAL `TelemetryDigestController` —
  // same pattern/gotcha as `telemetry.integration.spec.ts`'s own `buildApp()`:
  // a plain `useFactory` provider registration is NOT picked up by that
  // resolution path in a from-scratch `Test.createTestingModule`, so it must
  // be wired via `.overrideGuard(...).useValue(...)` instead.
  const moduleRef = await Test.createTestingModule({ imports: [TestModule] })
    .overrideGuard(TelemetryDigestTokenGuard)
    .useValue(
      new TelemetryDigestTokenGuard(fakeConfigService as unknown as ConfigService<never, true>),
    )
    .compile()
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
  // Same registration this endpoint gets in main.ts — a test app built by
  // hand (not via bootstrap()) needs it wired explicitly too.
  registerCspReportContentTypeParser(app)
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
      `SELECT table_name FROM information_schema.tables WHERE table_name='csp_reports' LIMIT 1`,
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

describe('CSP Reports — real backend integration', () => {
  let app: NestFastifyApplication
  let dbSvc: DatabaseService

  beforeAll(async () => {
    dbAvailable = await probeDb()
    if (!dbAvailable) {
      console.warn(
        '[csp-reports integration] SKIPPED — no DB reachable at DATABASE_URL, or csp_reports table missing (run db:push)',
      )
      return
    }

    // Relax the REAL per-route @RelaxableThrottle(CSP_REPORT_LIMIT=60) for
    // every test EXCEPT the dedicated "rate limit" describe block below
    // (same rationale as contact.integration.spec.ts) — otherwise the
    // shared `app` instance's other tests would eat into the real 60/hour
    // cap and risk seeing 429s where they don't mean to.
    process.env['THROTTLE_RELAXED'] = 'true'

    app = await buildApp()
    dbSvc = app.get(DatabaseService)

    // `csp_reports` is exclusively owned by THIS spec — a fresh slate makes
    // every assertion below deterministic (same pattern as
    // telemetry.integration.spec.ts's telemetry_events/telemetry_errors truncate).
    await dbSvc.db.execute('TRUNCATE TABLE csp_reports RESTART IDENTITY')
  }, 30_000)

  afterAll(async () => {
    delete process.env['THROTTLE_RELAXED']
    if (!dbAvailable) return
    try {
      await dbSvc.db.execute('TRUNCATE TABLE csp_reports RESTART IDENTITY')
      await dbSvc.db
        .delete(telemetryErrors)
        .where(eq(telemetryErrors.message, INGEST_FAILURE_MESSAGE))
    } catch {
      // non-fatal cleanup failure — do not mask test results
    }
    await app.close()
  }, 20_000)

  // ── AC2 — application/csp-report (report-uri) ────────────────────────────

  it('application/csp-report — 204, row created with normalized fields', async () => {
    if (!dbAvailable) return
    // `effective-directive` MUST be a real, allow-listed CSP directive
    // (HIGH-1c) — per-test isolation now comes from a unique `blocked-uri`
    // segment instead (still free text).
    const marker = `x-${Date.now()}`
    const res = await app.inject({
      method: 'POST',
      url: '/api/public/csp-report',
      headers: {
        'content-type': 'application/csp-report',
        'user-agent': 'IntegrationTestUA/1.0',
      },
      payload: JSON.stringify({
        'csp-report': {
          'document-uri': `${OUR_ORIGIN}/team?foo=bar`,
          'effective-directive': 'script-src',
          'blocked-uri': `https://evil.example/${marker}.js?q=1`,
          disposition: 'report',
        },
      }),
    })
    expect(res.statusCode).toBe(204)

    const row = await dbSvc.db.query.cspReports.findFirst({
      where: (t, { eq: eqOp }) => eqOp(t.blockedUri, `https://evil.example/${marker}.js`),
    })
    expect(row).toBeDefined()
    expect(row?.effectiveDirective).toBe('script-src')
    expect(row?.documentPath).toBe('/team')
    expect(row?.disposition).toBe('report')
    expect(row?.userAgent).toBe('IntegrationTestUA/1.0')
    expect(row?.count).toBe(1)
  })

  // ── AC2 — application/reports+json (report-to) ────────────────────────────

  it('application/reports+json — 204, row created from a csp-violation entry, non-csp-violation entries ignored', async () => {
    if (!dbAvailable) return
    const marker = `x-${Date.now()}`
    const res = await app.inject({
      method: 'POST',
      url: '/api/public/csp-report',
      headers: { 'content-type': 'application/reports+json' },
      payload: JSON.stringify([
        { type: 'deprecation', body: {} },
        {
          type: 'csp-violation',
          body: {
            documentURL: `${OUR_ORIGIN}/finance?token=x`,
            effectiveDirective: 'style-src',
            blockedURL: `https://cdn.evil.example/${marker}.css`,
            disposition: 'enforce',
          },
        },
      ]),
    })
    expect(res.statusCode).toBe(204)

    const row = await dbSvc.db.query.cspReports.findFirst({
      where: (t, { eq: eqOp }) => eqOp(t.blockedUri, `https://cdn.evil.example/${marker}.css`),
    })
    expect(row).toBeDefined()
    expect(row?.effectiveDirective).toBe('style-src')
    expect(row?.documentPath).toBe('/finance')
    expect(row?.disposition).toBe('enforce')
  })

  // ── AC2 — garbage → 204, no record ────────────────────────────────────────

  describe('AC2 — garbage input → 204, no record', () => {
    it('malformed JSON body (Content-Type matches, body is not valid JSON) → 204', async () => {
      if (!dbAvailable) return
      const res = await app.inject({
        method: 'POST',
        url: '/api/public/csp-report',
        headers: { 'content-type': 'application/csp-report' },
        payload: '{not valid json,,,',
      })
      expect(res.statusCode).toBe(204)
    })

    it('valid JSON but a completely unrelated shape (a bare number) → 204', async () => {
      if (!dbAvailable) return
      const res = await app.inject({
        method: 'POST',
        url: '/api/public/csp-report',
        headers: { 'content-type': 'application/csp-report' },
        payload: '42',
      })
      expect(res.statusCode).toBe(204)
    })

    it('csp-report with no usable directive → 204, no row created', async () => {
      if (!dbAvailable) return
      const marker = `no-directive-marker-${Date.now()}`
      const res = await app.inject({
        method: 'POST',
        url: '/api/public/csp-report',
        headers: { 'content-type': 'application/csp-report' },
        payload: JSON.stringify({
          'csp-report': { 'document-uri': `${OUR_ORIGIN}/x`, 'blocked-uri': marker },
        }),
      })
      expect(res.statusCode).toBe(204)

      const row = await dbSvc.db.query.cspReports.findFirst({
        where: (t, { eq: eqOp }) => eqOp(t.blockedUri, marker),
      })
      expect(row).toBeUndefined()
    })
  })

  // ── Security round 1 HIGH-1d — origin check (the mass-reflection vector) ──

  it('a document-uri from a FOREIGN origin is dropped → 204, no row created', async () => {
    if (!dbAvailable) return
    const marker = `foreign-origin-marker-${Date.now()}`
    const res = await app.inject({
      method: 'POST',
      url: '/api/public/csp-report',
      headers: { 'content-type': 'application/csp-report' },
      payload: JSON.stringify({
        'csp-report': {
          'document-uri': 'https://attacker.example/their-own-page',
          'effective-directive': 'script-src',
          'blocked-uri': marker,
        },
      }),
    })
    expect(res.statusCode).toBe(204)

    const row = await dbSvc.db.query.cspReports.findFirst({
      where: (t, { eq: eqOp }) => eqOp(t.blockedUri, marker),
    })
    expect(row).toBeUndefined()
  })

  // ── Security round 1 HIGH-1e — batch cap (Zod .max(10)) ───────────────────

  it('a reports+json batch over 10 entries is rejected wholesale → 204, no rows created', async () => {
    if (!dbAvailable) return
    const marker = `batch-cap-marker-${Date.now()}`
    const items = Array.from({ length: 11 }, (_, i) => ({
      type: 'csp-violation',
      body: {
        documentURL: `${OUR_ORIGIN}/x`,
        effectiveDirective: 'script-src',
        blockedURL: `${marker}-${i}`,
      },
    }))
    const res = await app.inject({
      method: 'POST',
      url: '/api/public/csp-report',
      headers: { 'content-type': 'application/reports+json' },
      payload: JSON.stringify(items),
    })
    expect(res.statusCode).toBe(204)

    const rows = await dbSvc.db.query.cspReports.findMany({
      where: (t, { like }) => like(t.blockedUri, `${marker}%`),
    })
    expect(rows).toHaveLength(0)
  })

  // ── LOW — 32 KB parser-level body limit (separate from the global limit) ─

  it('a body over the 32 KB parser limit is rejected with 413', async () => {
    if (!dbAvailable) return
    const oversized = JSON.stringify({
      'csp-report': {
        'document-uri': `${OUR_ORIGIN}/x`,
        'effective-directive': 'script-src',
        // Comfortably over 32 KB — a single oversized field, not a
        // realistic report, this is purely to exercise the parser-level cap.
        'blocked-uri': 'https://evil.example/' + 'x'.repeat(40 * 1024),
      },
    })
    const res = await app.inject({
      method: 'POST',
      url: '/api/public/csp-report',
      headers: { 'content-type': 'application/csp-report' },
      payload: oversized,
    })
    expect(res.statusCode).toBe(413)
  })

  // ── AC3 — dedup: 3 identical reports → 1 row, count=3 ─────────────────────

  it('AC3 — 3 identical csp-report submissions → 1 row, count=3', async () => {
    if (!dbAvailable) return
    const marker = `dedup-${Date.now()}`
    const body = JSON.stringify({
      'csp-report': {
        'document-uri': `${OUR_ORIGIN}/team`,
        'effective-directive': 'script-src',
        'blocked-uri': `https://evil.example/${marker}.js`,
      },
    })

    for (let i = 0; i < 3; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/public/csp-report',
        headers: { 'content-type': 'application/csp-report' },
        payload: body,
      })
      expect(res.statusCode).toBe(204)
    }

    const rows = await dbSvc.db.query.cspReports.findMany({
      where: (t, { eq: eqOp }) => eqOp(t.blockedUri, `https://evil.example/${marker}.js`),
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.count).toBe(3)
  })

  it('MED-2 — a conflicting submission does NOT overwrite disposition/userAgent (data-poisoning guard)', async () => {
    if (!dbAvailable) return
    const marker = `no-overwrite-${Date.now()}`
    const blockedUri = `https://evil.example/${marker}.js`
    const documentUri = `${OUR_ORIGIN}/no-overwrite`

    const first = await app.inject({
      method: 'POST',
      url: '/api/public/csp-report',
      headers: { 'content-type': 'application/csp-report', 'user-agent': 'FirstUA/1.0' },
      payload: JSON.stringify({
        'csp-report': {
          'document-uri': documentUri,
          'effective-directive': 'script-src',
          'blocked-uri': blockedUri,
          disposition: 'report',
        },
      }),
    })
    expect(first.statusCode).toBe(204)

    const second = await app.inject({
      method: 'POST',
      url: '/api/public/csp-report',
      headers: { 'content-type': 'application/csp-report', 'user-agent': 'SecondUA/2.0' },
      payload: JSON.stringify({
        'csp-report': {
          'document-uri': documentUri,
          'effective-directive': 'script-src',
          'blocked-uri': blockedUri,
          disposition: 'enforce',
        },
      }),
    })
    expect(second.statusCode).toBe(204)

    const row = await dbSvc.db.query.cspReports.findFirst({
      where: (t, { eq: eqOp }) => eqOp(t.blockedUri, blockedUri),
    })
    expect(row?.count).toBe(2)
    // First-observed values win — neither disposition nor userAgent flipped.
    expect(row?.disposition).toBe('report')
    expect(row?.userAgent).toBe('FirstUA/1.0')
  })

  // ── Security round 1 MED-3 — write failure IS observable (unlike garbage) ─

  it('a REAL write failure still responds 204, but is recorded into telemetry_errors with a FIXED message', async () => {
    if (!dbAvailable) return
    const svc = app.get(CspReportsService)
    const spy = vi
      .spyOn(svc, 'recordViolation')
      .mockRejectedValueOnce(new Error('simulated DB failure'))

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/public/csp-report',
        headers: { 'content-type': 'application/csp-report' },
        payload: JSON.stringify({
          'csp-report': {
            'document-uri': `${OUR_ORIGIN}/x`,
            'effective-directive': 'script-src',
            'blocked-uri': 'https://evil.example/whatever-the-payload-is.js',
          },
        }),
      })
      expect(res.statusCode).toBe(204)

      const errorRow = await dbSvc.db.query.telemetryErrors.findFirst({
        where: (t, { eq: eqOp }) => eqOp(t.message, INGEST_FAILURE_MESSAGE),
      })
      expect(errorRow).toBeDefined()
      expect(errorRow?.route).toBe('/api/public/csp-report')
      expect(errorRow?.source).toBe('API')
      // The attacker-controlled payload never lands in the (public-digest-
      // feeding) message — only the fixed string above.
      expect(errorRow?.message).not.toContain('whatever-the-payload-is')
    } finally {
      spy.mockRestore()
    }
  })

  // ── AC4 — digest visibility ────────────────────────────────────────────

  it('AC4 — a recorded violation appears in GET /api/telemetry/digest cspViolations, with cspViolationsTotal reflecting the match count', async () => {
    if (!dbAvailable) return
    const marker = `digest-visible-${Date.now()}`
    await app.inject({
      method: 'POST',
      url: '/api/public/csp-report',
      headers: { 'content-type': 'application/csp-report' },
      payload: JSON.stringify({
        'csp-report': {
          'document-uri': `${OUR_ORIGIN}/x`,
          'effective-directive': 'script-src',
          'blocked-uri': `https://evil.example/${marker}.js`,
        },
      }),
    })

    const since = new Date(0).toISOString()
    const res = await app.inject({
      method: 'GET',
      url: `/api/telemetry/digest?since=${encodeURIComponent(since)}`,
      headers: { 'x-telemetry-token': DIGEST_TOKEN },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      cspViolations: { blockedUri: string }[]
      cspViolationsTotal: number
    }
    expect(
      body.cspViolations.some((v) => v.blockedUri === `https://evil.example/${marker}.js`),
    ).toBe(true)
    expect(body.cspViolationsTotal).toBeGreaterThanOrEqual(1)
  })

  // ── AC2 — rate limit (own dedicated app instance — own throttle store) ──

  describe('AC2 — rate limit (429 once CSP_REPORT_LIMIT/60/hour is exceeded)', () => {
    it('returns 429 once the real per-endpoint cap is exceeded within the window', async () => {
      if (!dbAvailable) return
      const previousRelaxed = process.env['THROTTLE_RELAXED']
      process.env['THROTTLE_RELAXED'] = 'false'
      const rlApp = await buildApp(1_000)
      try {
        let hitAt = 0
        for (let i = 1; i <= 61; i++) {
          const res = await rlApp.inject({
            method: 'POST',
            url: '/api/public/csp-report',
            headers: { 'content-type': 'application/csp-report' },
            payload: JSON.stringify({
              'csp-report': {
                'document-uri': `${OUR_ORIGIN}/x`,
                'effective-directive': 'script-src',
                'blocked-uri': `rl-probe-${i}-${Date.now()}`,
              },
            }),
          })
          if (res.statusCode === 429) {
            hitAt = i
            break
          }
        }
        expect(hitAt, 'Expected 429 within 61 requests (CSP_REPORT_LIMIT=60)').toBe(61)
      } finally {
        await rlApp.close()
        process.env['THROTTLE_RELAXED'] = previousRelaxed
      }
    }, 30_000)
  })
})
