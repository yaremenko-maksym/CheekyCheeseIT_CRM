/**
 * CSP Reports — real-backend integration spec (real Postgres, real Fastify
 * HTTP pipeline, real ThrottlerGuard, real custom content-type parser).
 * Same pattern as `telemetry.integration.spec.ts` / `contact.integration.spec.ts`.
 *
 * Covers (task-csp-reports-and-flip §Часть A item 6):
 *   AC2 — both Content-Types accepted (application/csp-report,
 *         application/reports+json); garbage body → 204, no record;
 *         rate-limit 429 once CSP_REPORT_LIMIT (60/hour) is exceeded.
 *   AC3 — dedup: 3 identical reports → 1 row, count=3.
 *   AC4 — a recorded violation is visible in GET /api/telemetry/digest's
 *         `cspViolations` section.
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
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { DatabaseService } from '../database/database.service'
import * as schema from '../database/schema'
import { TelemetryDigestTokenGuard } from '../telemetry/telemetry-digest-token.guard'
import { TelemetryDigestController } from '../telemetry/telemetry-digest.controller'
import { TelemetryDigestService } from '../telemetry/telemetry-digest.service'
import { ZodExceptionFilter } from '../zod-exception.filter'
import { registerCspReportContentTypeParser } from './csp-report-content-type-parser'
import { CspReportsController } from './csp-reports.controller'
import { CspReportsService } from './csp-reports.service'

const DIGEST_TOKEN = 'csp-reports-integration-real-digest-token-32chars!!'

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
        useFactory: (db: DatabaseService) => new CspReportsService(db),
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
    } catch {
      // non-fatal cleanup failure — do not mask test results
    }
    await app.close()
  }, 20_000)

  // ── AC2 — application/csp-report (report-uri) ────────────────────────────

  it('application/csp-report — 204, row created with normalized fields', async () => {
    if (!dbAvailable) return
    const directive = `script-src-test-${Date.now()}`
    const res = await app.inject({
      method: 'POST',
      url: '/api/public/csp-report',
      headers: {
        'content-type': 'application/csp-report',
        'user-agent': 'IntegrationTestUA/1.0',
      },
      payload: JSON.stringify({
        'csp-report': {
          'document-uri': 'https://app.cheekycheese.tech/team?foo=bar',
          'effective-directive': directive,
          'blocked-uri': 'https://evil.example/x.js?q=1',
          disposition: 'report',
        },
      }),
    })
    expect(res.statusCode).toBe(204)

    const row = await dbSvc.db.query.cspReports.findFirst({
      where: (t, { eq: eqOp }) => eqOp(t.effectiveDirective, directive),
    })
    expect(row).toBeDefined()
    expect(row?.blockedUri).toBe('https://evil.example/x.js')
    expect(row?.documentPath).toBe('/team')
    expect(row?.disposition).toBe('report')
    expect(row?.userAgent).toBe('IntegrationTestUA/1.0')
    expect(row?.count).toBe(1)
  })

  // ── AC2 — application/reports+json (report-to) ────────────────────────────

  it('application/reports+json — 204, row created from a csp-violation entry, non-csp-violation entries ignored', async () => {
    if (!dbAvailable) return
    const directive = `style-src-test-${Date.now()}`
    const res = await app.inject({
      method: 'POST',
      url: '/api/public/csp-report',
      headers: { 'content-type': 'application/reports+json' },
      payload: JSON.stringify([
        { type: 'deprecation', body: {} },
        {
          type: 'csp-violation',
          body: {
            documentURL: 'https://app.cheekycheese.tech/finance?token=x',
            effectiveDirective: directive,
            blockedURL: 'https://cdn.evil.example/x.css',
            disposition: 'enforce',
          },
        },
      ]),
    })
    expect(res.statusCode).toBe(204)

    const row = await dbSvc.db.query.cspReports.findFirst({
      where: (t, { eq: eqOp }) => eqOp(t.effectiveDirective, directive),
    })
    expect(row).toBeDefined()
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
        payload: JSON.stringify({ 'csp-report': { 'blocked-uri': marker } }),
      })
      expect(res.statusCode).toBe(204)

      const row = await dbSvc.db.query.cspReports.findFirst({
        where: (t, { eq: eqOp }) => eqOp(t.blockedUri, marker),
      })
      expect(row).toBeUndefined()
    })
  })

  // ── AC3 — dedup: 3 identical reports → 1 row, count=3 ─────────────────────

  it('AC3 — 3 identical csp-report submissions → 1 row, count=3', async () => {
    if (!dbAvailable) return
    const directive = `dedup-test-${Date.now()}`
    const body = JSON.stringify({
      'csp-report': {
        'document-uri': 'https://app.cheekycheese.tech/team',
        'effective-directive': directive,
        'blocked-uri': 'https://evil.example/dup.js',
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
      where: (t, { eq: eqOp }) => eqOp(t.effectiveDirective, directive),
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.count).toBe(3)
  })

  // ── AC4 — digest visibility ────────────────────────────────────────────

  it('AC4 — a recorded violation appears in GET /api/telemetry/digest cspViolations', async () => {
    if (!dbAvailable) return
    const directive = `digest-visible-test-${Date.now()}`
    await app.inject({
      method: 'POST',
      url: '/api/public/csp-report',
      headers: { 'content-type': 'application/csp-report' },
      payload: JSON.stringify({
        'csp-report': {
          'effective-directive': directive,
          'blocked-uri': 'https://evil.example/v.js',
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
    const body = res.json() as { cspViolations: { effectiveDirective: string }[] }
    expect(body.cspViolations.some((v) => v.effectiveDirective === directive)).toBe(true)
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
              'csp-report': { 'effective-directive': `rl-probe-${i}-${Date.now()}` },
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
