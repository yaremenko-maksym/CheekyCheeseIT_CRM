import { ConfigService } from '@nestjs/config'
import { describe, expect, it, vi } from 'vitest'
import type { Env } from '../config/env'
import type { DatabaseService } from '../database/database.service'
import type { TelemetryErrorsService } from '../telemetry/telemetry-errors.service'
import {
  CSP_REPORT_ROUTE,
  CSP_REPORTS_CAP_REACHED_MESSAGE,
  CSP_REPORTS_ROW_CAP,
  CspReportsService,
  USER_AGENT_MAX_LENGTH,
} from './csp-reports.service'

/**
 * Unit tests for the orchestration around the upsert (origin check /
 * directive allow-list / normalize / sanitize / row-cap budget + the exact
 * `.values()`/`.onConflictDoUpdate()` shape passed to Drizzle) — mirrors
 * `telemetry-errors.service.spec.ts`. The ACTUAL Postgres upsert semantics
 * (count++, unique-by-aggregation-key grouping) can only be proven against
 * a real Postgres — see `csp-reports.integration.spec.ts`.
 */

const OUR_ORIGIN = 'https://app.cheekycheese.tech'
const VALID_DOCUMENT_URI = `${OUR_ORIGIN}/team?code=abc`

function makeConfigService(): ConfigService<Env, true> {
  const env: Record<string, unknown> = {
    FRONTEND_URL: OUR_ORIGIN,
    CORS_ORIGINS: undefined,
    NODE_ENV: 'test',
  }
  return { get: (key: string) => env[key] } as unknown as ConfigService<Env, true>
}

function makeTelemetryErrorsService(): {
  telemetryErrors: TelemetryErrorsService
  recordError: ReturnType<typeof vi.fn>
} {
  const recordError = vi.fn(async () => undefined)
  return { telemetryErrors: { recordError } as unknown as TelemetryErrorsService, recordError }
}

interface InsertCall {
  values?: unknown
  onConflict?: { target: unknown; set: Record<string, unknown> }
}

function makeDb(opts: { existingRows?: unknown[]; rowCount?: number } = {}): {
  db: DatabaseService
  calls: InsertCall[]
} {
  const calls: InsertCall[] = []
  const existingRows = opts.existingRows ?? []
  const rowCount = opts.rowCount ?? 0
  const db = {
    db: {
      select: (fields: Record<string, unknown>) => ({
        from: () => {
          if ('count' in fields) {
            // getApproxRowCount() — `.select({count}).from(table)`, no further chain.
            return Promise.resolve([{ count: rowCount }])
          }
          // isNewAggregationKey() — `.select({id}).from(table).where(...).limit(1)`.
          return {
            where: () => ({
              limit: async () => existingRows,
            }),
          }
        },
      }),
      insert: (_table: unknown) => {
        const call: InsertCall = {}
        calls.push(call)
        return {
          values: (v: unknown) => {
            call.values = v
            return {
              onConflictDoUpdate: (o: { target: unknown; set: Record<string, unknown> }) => {
                call.onConflict = o
                return Promise.resolve(undefined)
              },
            }
          },
        }
      },
    },
  }
  return { db: db as unknown as DatabaseService, calls }
}

describe('CspReportsService.recordViolation', () => {
  it('inserts with the resolved directive, normalized blockedUri/documentPath, count=1', async () => {
    const { db, calls } = makeDb()
    const svc = new CspReportsService(
      db,
      makeConfigService(),
      makeTelemetryErrorsService().telemetryErrors,
    )

    await svc.recordViolation({
      effectiveDirective: 'script-src',
      blockedUri: 'https://evil.example/x.js?foo=bar',
      documentUri: VALID_DOCUMENT_URI,
      disposition: 'report',
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.values).toMatchObject({
      effectiveDirective: 'script-src',
      blockedUri: 'https://evil.example/x.js',
      documentPath: '/team',
      disposition: 'report',
      count: 1,
    })
  })

  it('does NOT insert when the document-uri origin is not ours (HIGH-1d — the mass-reflection vector)', async () => {
    const { db, calls } = makeDb()
    const svc = new CspReportsService(
      db,
      makeConfigService(),
      makeTelemetryErrorsService().telemetryErrors,
    )

    await svc.recordViolation({
      effectiveDirective: 'script-src',
      documentUri: 'https://evil.example/attacker-page',
    })

    expect(calls).toHaveLength(0)
  })

  it('does NOT insert when document-uri is missing entirely', async () => {
    const { db, calls } = makeDb()
    const svc = new CspReportsService(
      db,
      makeConfigService(),
      makeTelemetryErrorsService().telemetryErrors,
    )

    await svc.recordViolation({ effectiveDirective: 'script-src' })

    expect(calls).toHaveLength(0)
  })

  it('does NOT insert when neither effective-directive nor violated-directive is allow-listed (HIGH-1c)', async () => {
    const { db, calls } = makeDb()
    const svc = new CspReportsService(
      db,
      makeConfigService(),
      makeTelemetryErrorsService().telemetryErrors,
    )

    await svc.recordViolation({
      documentUri: VALID_DOCUMENT_URI,
      blockedUri: 'https://evil.example/x.js',
    })

    expect(calls).toHaveLength(0)
  })

  it('does NOT insert an arbitrary non-CSP-directive string, even if non-empty', async () => {
    const { db, calls } = makeDb()
    const svc = new CspReportsService(
      db,
      makeConfigService(),
      makeTelemetryErrorsService().telemetryErrors,
    )

    await svc.recordViolation({
      documentUri: VALID_DOCUMENT_URI,
      effectiveDirective: 'totally-made-up-directive',
    })

    expect(calls).toHaveLength(0)
  })

  it('falls back to violated-directive when effective-directive is missing', async () => {
    const { db, calls } = makeDb()
    const svc = new CspReportsService(
      db,
      makeConfigService(),
      makeTelemetryErrorsService().telemetryErrors,
    )

    await svc.recordViolation({
      documentUri: VALID_DOCUMENT_URI,
      violatedDirective: "style-src 'self'",
    })

    expect(calls[0]!.values).toMatchObject({ effectiveDirective: 'style-src' })
  })

  it('defaults disposition to "report" when omitted', async () => {
    const { db, calls } = makeDb()
    const svc = new CspReportsService(
      db,
      makeConfigService(),
      makeTelemetryErrorsService().telemetryErrors,
    )

    await svc.recordViolation({ documentUri: VALID_DOCUMENT_URI, effectiveDirective: 'script-src' })

    expect(calls[0]!.values).toMatchObject({ disposition: 'report' })
  })

  it('does NOT mangle a cookie-consent blockedUri (MED-4 regression, end-to-end through the service)', async () => {
    const { db, calls } = makeDb()
    const svc = new CspReportsService(
      db,
      makeConfigService(),
      makeTelemetryErrorsService().telemetryErrors,
    )

    await svc.recordViolation({
      documentUri: VALID_DOCUMENT_URI,
      effectiveDirective: 'script-src',
      blockedUri: 'https://consent.cookiebot.com/uc.js',
    })

    expect(calls[0]!.values).toMatchObject({ blockedUri: 'https://consent.cookiebot.com/uc.js' })
  })

  it('redacts a Bearer-token-shaped blockedUri before normalizing/storing', async () => {
    const { db, calls } = makeDb()
    const svc = new CspReportsService(
      db,
      makeConfigService(),
      makeTelemetryErrorsService().telemetryErrors,
    )

    await svc.recordViolation({
      documentUri: VALID_DOCUMENT_URI,
      effectiveDirective: 'connect-src',
      blockedUri: 'https://evil.example/steal?Authorization=Bearer sekrit-token-xyz',
    })

    const values = calls[0]!.values as { blockedUri: string }
    // Query string is stripped by normalization regardless, but the sanitize
    // step runs FIRST (defense-in-depth) — assert the secret never survives.
    expect(values.blockedUri).not.toContain('sekrit-token-xyz')
  })

  it('sanitizes AND truncates the User-Agent header before storing (byte-based cap)', async () => {
    const { db, calls } = makeDb()
    const svc = new CspReportsService(
      db,
      makeConfigService(),
      makeTelemetryErrorsService().telemetryErrors,
    )

    await svc.recordViolation({
      documentUri: VALID_DOCUMENT_URI,
      effectiveDirective: 'script-src',
      userAgent: `Bearer sekrit-ua-token ${'x'.repeat(USER_AGENT_MAX_LENGTH)}`,
    })

    const values = calls[0]!.values as { userAgent: string }
    expect(values.userAgent).not.toContain('sekrit-ua-token')
    expect(Buffer.byteLength(values.userAgent, 'utf8')).toBeLessThanOrEqual(USER_AGENT_MAX_LENGTH)
  })

  it('strips control characters (CRLF) from the User-Agent header', async () => {
    const { db, calls } = makeDb()
    const svc = new CspReportsService(
      db,
      makeConfigService(),
      makeTelemetryErrorsService().telemetryErrors,
    )

    await svc.recordViolation({
      documentUri: VALID_DOCUMENT_URI,
      effectiveDirective: 'script-src',
      userAgent: 'Mozilla/5.0\r\nX-Injected: evil',
    })

    const values = calls[0]!.values as { userAgent: string }
    expect(values.userAgent).not.toMatch(/[\r\n]/)
  })

  it('stores userAgent as null when omitted', async () => {
    const { db, calls } = makeDb()
    const svc = new CspReportsService(
      db,
      makeConfigService(),
      makeTelemetryErrorsService().telemetryErrors,
    )

    await svc.recordViolation({ documentUri: VALID_DOCUMENT_URI, effectiveDirective: 'script-src' })

    expect((calls[0]!.values as { userAgent: unknown }).userAgent).toBeNull()
  })

  it('targets the (effectiveDirective, blockedUri, documentPath) composite key for onConflictDoUpdate, and does NOT overwrite disposition/userAgent (MED-2)', async () => {
    const { db, calls } = makeDb()
    const svc = new CspReportsService(
      db,
      makeConfigService(),
      makeTelemetryErrorsService().telemetryErrors,
    )

    await svc.recordViolation({ documentUri: VALID_DOCUMENT_URI, effectiveDirective: 'script-src' })

    const onConflict = calls[0]!.onConflict!
    expect(onConflict.target).toHaveLength(3)
    expect(onConflict.set).toHaveProperty('count')
    expect(onConflict.set).toHaveProperty('lastSeen')
    expect(onConflict.set).not.toHaveProperty('disposition')
    expect(onConflict.set).not.toHaveProperty('userAgent')
  })

  it('row-cap budget (HIGH-1a/b): refuses a NEW aggregation key once the row cap is reached', async () => {
    const { db, calls } = makeDb({ existingRows: [], rowCount: CSP_REPORTS_ROW_CAP })
    const svc = new CspReportsService(
      db,
      makeConfigService(),
      makeTelemetryErrorsService().telemetryErrors,
    )

    await svc.recordViolation({ documentUri: VALID_DOCUMENT_URI, effectiveDirective: 'script-src' })

    expect(calls).toHaveLength(0)
  })

  it('row-cap budget: still allows count++ on an EXISTING key once the row cap is reached', async () => {
    const { db, calls } = makeDb({
      existingRows: [{ id: 'existing-row-id' }],
      rowCount: CSP_REPORTS_ROW_CAP,
    })
    const svc = new CspReportsService(
      db,
      makeConfigService(),
      makeTelemetryErrorsService().telemetryErrors,
    )

    await svc.recordViolation({ documentUri: VALID_DOCUMENT_URI, effectiveDirective: 'script-src' })

    expect(calls).toHaveLength(1)
  })

  it('allows a new key when the row count is comfortably under the cap', async () => {
    const { db, calls } = makeDb({ existingRows: [], rowCount: CSP_REPORTS_ROW_CAP - 1 })
    const svc = new CspReportsService(
      db,
      makeConfigService(),
      makeTelemetryErrorsService().telemetryErrors,
    )

    await svc.recordViolation({ documentUri: VALID_DOCUMENT_URI, effectiveDirective: 'script-src' })

    expect(calls).toHaveLength(1)
  })

  // security round 2 (MED-residual)
  it('row-cap rejection records a FIXED telemetry error (never the sender payload), so "0 violations" stays distinguishable from "cap exhausted"', async () => {
    const { db, calls } = makeDb({ existingRows: [], rowCount: CSP_REPORTS_ROW_CAP })
    const { telemetryErrors, recordError } = makeTelemetryErrorsService()
    const svc = new CspReportsService(db, makeConfigService(), telemetryErrors)

    await svc.recordViolation({
      documentUri: VALID_DOCUMENT_URI,
      effectiveDirective: 'script-src',
      blockedUri: 'https://evil.example/attacker-controlled-payload.js',
    })

    expect(calls).toHaveLength(0)
    expect(recordError).toHaveBeenCalledTimes(1)
    expect(recordError).toHaveBeenCalledWith({
      source: 'API',
      message: CSP_REPORTS_CAP_REACHED_MESSAGE,
      route: CSP_REPORT_ROUTE,
    })
    const call = recordError.mock.calls[0]![0] as { message: string }
    expect(call.message).not.toContain('attacker-controlled-payload')
  })

  it('does NOT record a telemetry error for a count++ on an existing key, even at the cap', async () => {
    const { db } = makeDb({
      existingRows: [{ id: 'existing-row-id' }],
      rowCount: CSP_REPORTS_ROW_CAP,
    })
    const { telemetryErrors, recordError } = makeTelemetryErrorsService()
    const svc = new CspReportsService(db, makeConfigService(), telemetryErrors)

    await svc.recordViolation({ documentUri: VALID_DOCUMENT_URI, effectiveDirective: 'script-src' })

    expect(recordError).not.toHaveBeenCalled()
  })
})
