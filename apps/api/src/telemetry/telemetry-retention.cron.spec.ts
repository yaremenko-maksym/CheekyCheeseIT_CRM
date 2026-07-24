import { Logger } from '@nestjs/common'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseService } from '../database/database.service'
import {
  cutoffDate,
  ERRORS_RETENTION_DAYS,
  EVENTS_RETENTION_DAYS,
  EVENTS_ROW_CAP,
  TelemetryRetentionCronService,
} from './telemetry-retention.cron'

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = new Date('2026-07-24T12:00:00Z')

/**
 * Section A — retention boundary (AC7, EXPLICITLY unit-tested per the
 * task-file contract, unlike vacancies' equivalent 90-day boundary which
 * lives in an integration spec). `cutoffDate(now, days)` is the exact
 * formula `deleteEventsOlderThan`/`deleteErrorsOlderThan` feed into their
 * real `lt()` predicate — pinning it here pins the real query's boundary.
 */
describe('cutoffDate — events retention boundary (90 days)', () => {
  it('an 89-day-old row is NOT older than cutoff (kept)', () => {
    const ts = new Date(NOW.getTime() - 89 * DAY_MS)
    expect(ts.getTime() < cutoffDate(NOW, EVENTS_RETENTION_DAYS).getTime()).toBe(false)
  })

  it('an EXACTLY-90-day-old row is NOT older than cutoff (kept — inclusive boundary)', () => {
    const ts = new Date(NOW.getTime() - 90 * DAY_MS)
    expect(ts.getTime() < cutoffDate(NOW, EVENTS_RETENTION_DAYS).getTime()).toBe(false)
  })

  it('a 91-day-old row IS older than cutoff (deleted)', () => {
    const ts = new Date(NOW.getTime() - 91 * DAY_MS)
    expect(ts.getTime() < cutoffDate(NOW, EVENTS_RETENTION_DAYS).getTime()).toBe(true)
  })
})

describe('cutoffDate — errors retention boundary (180 days)', () => {
  it('a 179-day-old row is NOT older than cutoff (kept)', () => {
    const ts = new Date(NOW.getTime() - 179 * DAY_MS)
    expect(ts.getTime() < cutoffDate(NOW, ERRORS_RETENTION_DAYS).getTime()).toBe(false)
  })

  it('an EXACTLY-180-day-old row is NOT older than cutoff (kept — inclusive boundary)', () => {
    const ts = new Date(NOW.getTime() - 180 * DAY_MS)
    expect(ts.getTime() < cutoffDate(NOW, ERRORS_RETENTION_DAYS).getTime()).toBe(false)
  })

  it('a 181-day-old row IS older than cutoff (deleted)', () => {
    const ts = new Date(NOW.getTime() - 181 * DAY_MS)
    expect(ts.getTime() < cutoffDate(NOW, ERRORS_RETENTION_DAYS).getTime()).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Section B — enforceEventsCap (AC7 cap-branch, unit)
// ---------------------------------------------------------------------------

function makeCapDb(opts: { total: number; oldestIds: number[] }): {
  db: DatabaseService
  getDeleteWhereArg: () => unknown
} {
  let deleteWhereArg: unknown
  const db = {
    db: {
      select: (fields: Record<string, unknown>) => ({
        from: () => {
          if ('count' in fields) {
            return Promise.resolve([{ count: opts.total }])
          }
          return {
            orderBy: () => ({
              limit: async (n: number) => opts.oldestIds.slice(0, n).map((id) => ({ id })),
            }),
          }
        },
      }),
      delete: () => ({
        where: async (whereArg: unknown) => {
          deleteWhereArg = whereArg
          return undefined
        },
      }),
    },
  }
  return { db: db as unknown as DatabaseService, getDeleteWhereArg: () => deleteWhereArg }
}

describe('TelemetryRetentionCronService.enforceEventsCap', () => {
  it('does nothing and returns 0 when total is at or below the cap', async () => {
    const { db, getDeleteWhereArg } = makeCapDb({ total: EVENTS_ROW_CAP, oldestIds: [] })
    const svc = new TelemetryRetentionCronService(db)

    const deleted = await svc.enforceEventsCap()

    expect(deleted).toBe(0)
    expect(getDeleteWhereArg()).toBeUndefined()
  })

  it('deletes exactly the excess-over-cap oldest rows when total exceeds the cap', async () => {
    const oldestIds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    const { db, getDeleteWhereArg } = makeCapDb({ total: EVENTS_ROW_CAP + 10, oldestIds })
    const svc = new TelemetryRetentionCronService(db)

    const deleted = await svc.enforceEventsCap()

    expect(deleted).toBe(10)
    expect(getDeleteWhereArg()).toBeDefined()
  })

  it('returns 0 when total is 0 (empty table)', async () => {
    const { db } = makeCapDb({ total: 0, oldestIds: [] })
    const svc = new TelemetryRetentionCronService(db)

    expect(await svc.enforceEventsCap()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Section C — purgeExpired orchestration + handleRetention (never throws)
// ---------------------------------------------------------------------------

describe('TelemetryRetentionCronService.purgeExpired — orchestration', () => {
  it('sums eventsDeletedByAge + eventsDeletedByCap into eventsDeleted', async () => {
    const db = {} as unknown as DatabaseService
    const svc = new TelemetryRetentionCronService(db)
    vi.spyOn(svc, 'deleteEventsOlderThan').mockResolvedValue(5)
    vi.spyOn(svc, 'deleteErrorsOlderThan').mockResolvedValue(2)
    vi.spyOn(svc, 'enforceEventsCap').mockResolvedValue(3)

    const result = await svc.purgeExpired(NOW)

    expect(result).toEqual({
      eventsDeletedByAge: 5,
      eventsDeletedByCap: 3,
      eventsDeleted: 8,
      errorsDeleted: 2,
    })
  })
})

describe('TelemetryRetentionCronService.handleRetention (the @Cron entrypoint)', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('resolves (never throws) and logs success when purge completes normally', async () => {
    const db = {} as unknown as DatabaseService
    const svc = new TelemetryRetentionCronService(db)
    vi.spyOn(svc, 'purgeExpired').mockResolvedValue({
      eventsDeletedByAge: 0,
      eventsDeletedByCap: 0,
      eventsDeleted: 0,
      errorsDeleted: 0,
    })

    await expect(svc.handleRetention()).resolves.toBeUndefined()
    expect(logSpy).toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('catches an unexpected error from purgeExpired, logs it, and does NOT rethrow', async () => {
    const db = {} as unknown as DatabaseService
    const svc = new TelemetryRetentionCronService(db)
    vi.spyOn(svc, 'purgeExpired').mockRejectedValue(new Error('DB connection lost'))

    await expect(svc.handleRetention()).resolves.toBeUndefined()
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('retention cron failed'),
      expect.anything(),
    )
  })
})
