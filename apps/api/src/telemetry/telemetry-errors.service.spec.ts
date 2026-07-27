import { describe, expect, it } from 'vitest'
import type { DatabaseService } from '../database/database.service'
import { computeFingerprint } from './fingerprint'
import {
  MESSAGE_MAX_LENGTH,
  STACK_MAX_LENGTH,
  TELEMETRY_ERRORS_CAP_REACHED_MESSAGE,
  TELEMETRY_ERRORS_ROW_CAP,
  TelemetryErrorsService,
} from './telemetry-errors.service'

/**
 * Unit tests for the orchestration around the upsert (sanitize/truncate/
 * fingerprint + the exact `.values()`/`.onConflictDoUpdate()` shape passed to
 * Drizzle) AND the row-cap budget (task-telemetry-caps — mirrors
 * `csp-reports.service.spec.ts`'s own row-cap tests). The ACTUAL Postgres
 * upsert semantics (count++, RESOLVED→NEW regression, unique-by-fingerprint
 * grouping, real cap enforcement) can only be proven against a real Postgres
 * — see `telemetry.integration.spec.ts` (AC2/AC3/AC4 + row-cap section).
 */

interface InsertCall {
  values?: unknown
  onConflict?: { target: unknown; set: Record<string, unknown> }
}

/**
 * `opts.existingRows`/`opts.rowCount` drive the two SELECTs `recordError`
 * now issues before every upsert (`isNewFingerprint` / `getApproxRowCount`)
 * — same discriminate-by-`fields`-shape pattern as
 * `csp-reports.service.spec.ts`'s own `makeDb`. Defaults (`[]`/`0`) keep
 * every PRE-EXISTING test in this file passing unchanged: every fingerprint
 * looks "new", and the row count is always comfortably under the cap.
 */
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
          // isNewFingerprint() — `.select({id}).from(table).where(...).limit(1)`.
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

describe('TelemetryErrorsService.recordError', () => {
  it('inserts with the computed fingerprint, count=1, status=NEW', async () => {
    const { db, calls } = makeDb()
    const svc = new TelemetryErrorsService(db)

    await svc.recordError({ source: 'WEB', message: 'boom', stack: 'at foo (a.js:1:1)' })

    const expectedFingerprint = computeFingerprint({
      source: 'WEB',
      message: 'boom',
      stack: 'at foo (a.js:1:1)',
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.values).toMatchObject({
      fingerprint: expectedFingerprint,
      source: 'WEB',
      message: 'boom',
      count: 1,
      status: 'NEW',
    })
  })

  it('sanitizes AND truncates message/stack before storing', async () => {
    const { db, calls } = makeDb()
    const svc = new TelemetryErrorsService(db)

    await svc.recordError({
      source: 'API',
      message: `Bearer sekrit-token-1234 broke ${'x'.repeat(MESSAGE_MAX_LENGTH)}`,
      stack: `Bearer another-sekrit ${'y'.repeat(STACK_MAX_LENGTH)}`,
    })

    const values = calls[0]!.values as { message: string; stack: string }
    expect(values.message).not.toContain('sekrit-token-1234')
    expect(values.message.length).toBeLessThanOrEqual(MESSAGE_MAX_LENGTH)
    expect(values.stack).not.toContain('another-sekrit')
    expect(values.stack.length).toBeLessThanOrEqual(STACK_MAX_LENGTH)
  })

  it('stores stack as null when omitted', async () => {
    const { db, calls } = makeDb()
    const svc = new TelemetryErrorsService(db)

    await svc.recordError({ source: 'WEB', message: 'boom' })

    expect((calls[0]!.values as { stack: unknown }).stack).toBeNull()
  })

  it('defaults route/userId/userRole to null and meta to {} when omitted', async () => {
    const { db, calls } = makeDb()
    const svc = new TelemetryErrorsService(db)

    await svc.recordError({ source: 'WEB', message: 'boom' })

    expect(calls[0]!.values).toMatchObject({
      route: null,
      userId: null,
      userRole: null,
      meta: {},
    })
  })

  it('sec HIGH (review round 1): strips a query string from a client-submitted route before storing', async () => {
    const { db, calls } = makeDb()
    const svc = new TelemetryErrorsService(db)

    await svc.recordError({
      source: 'WEB',
      message: 'boom',
      route: '/auth/google/callback?code=secret-oauth-code&state=csrf-state-value',
    })

    const values = calls[0]!.values as { route: string }
    expect(values.route).toBe('/auth/google/callback')
    expect(values.route).not.toContain('code=')
    expect(values.route).not.toContain('secret-oauth-code')
  })

  it('passes through route/userId/userRole/meta when provided', async () => {
    const { db, calls } = makeDb()
    const svc = new TelemetryErrorsService(db)

    await svc.recordError({
      source: 'WEB',
      message: 'boom',
      route: '/finance',
      userId: '11111111-1111-4111-8111-111111111111',
      userRole: 'SENIOR',
      meta: { ua: 'Mozilla/5.0', viewport: '1920x1080' },
    })

    expect(calls[0]!.values).toMatchObject({
      route: '/finance',
      userId: '11111111-1111-4111-8111-111111111111',
      userRole: 'SENIOR',
      meta: { ua: 'Mozilla/5.0', viewport: '1920x1080' },
    })
  })

  it('targets the fingerprint column for onConflictDoUpdate and sets count/lastSeen/status', async () => {
    const { db, calls } = makeDb()
    const svc = new TelemetryErrorsService(db)

    await svc.recordError({ source: 'WEB', message: 'boom' })

    const onConflict = calls[0]!.onConflict!
    expect(onConflict.set).toHaveProperty('count')
    expect(onConflict.set).toHaveProperty('lastSeen')
    expect(onConflict.set).toHaveProperty('status')
  })
})

// task-telemetry-caps — row-cap budget (mirrors csp-reports.service.spec.ts).
describe('TelemetryErrorsService.recordError — row-cap budget', () => {
  it('AC1: refuses a NEW fingerprint once the row cap is reached, but records the fixed cap-reached signal instead of the rejected occurrence', async () => {
    const { db, calls } = makeDb({ existingRows: [], rowCount: TELEMETRY_ERRORS_ROW_CAP })
    const svc = new TelemetryErrorsService(db)

    await svc.recordError({
      source: 'WEB',
      message: 'attacker-controlled unique error signature #12345',
    })

    const expectedCapFingerprint = computeFingerprint({
      source: 'API',
      message: TELEMETRY_ERRORS_CAP_REACHED_MESSAGE,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.values).toMatchObject({
      fingerprint: expectedCapFingerprint,
      message: TELEMETRY_ERRORS_CAP_REACHED_MESSAGE,
      count: 1,
    })
    const values = calls[0]!.values as { message: string }
    expect(values.message).not.toContain('attacker-controlled')
  })

  it('AC1: still allows count++ on an EXISTING fingerprint once the row cap is reached', async () => {
    const { db, calls } = makeDb({
      existingRows: [{ id: 'existing-row-id' }],
      rowCount: TELEMETRY_ERRORS_ROW_CAP,
    })
    const svc = new TelemetryErrorsService(db)

    await svc.recordError({ source: 'WEB', message: 'boom, already tracked' })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.values).toMatchObject({ message: 'boom, already tracked' })
    expect(calls[0]!.onConflict).toBeDefined()
  })

  it('allows a new fingerprint when the row count is comfortably under the cap', async () => {
    const { db, calls } = makeDb({ existingRows: [], rowCount: TELEMETRY_ERRORS_ROW_CAP - 1 })
    const svc = new TelemetryErrorsService(db)

    await svc.recordError({ source: 'WEB', message: 'boom' })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.values).toMatchObject({ message: 'boom' })
  })

  it('AC2: the cap-reached signal always targets the SAME fixed fingerprint — repeated rejections dedupe via onConflictDoUpdate, never flooding the table', async () => {
    const { db, calls } = makeDb({ existingRows: [], rowCount: TELEMETRY_ERRORS_ROW_CAP })
    const svc = new TelemetryErrorsService(db)

    await svc.recordError({ source: 'WEB', message: 'unique error A' })
    await svc.recordError({ source: 'API', message: 'unique error B, totally different text' })

    expect(calls).toHaveLength(2)
    const fp1 = (calls[0]!.values as { fingerprint: string }).fingerprint
    const fp2 = (calls[1]!.values as { fingerprint: string }).fingerprint
    expect(fp1).toBe(fp2)
    expect(calls[0]!.onConflict).toBeDefined()
    expect(calls[1]!.onConflict).toBeDefined()
  })
})
