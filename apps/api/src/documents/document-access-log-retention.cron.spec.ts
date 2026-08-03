/**
 * DocumentAccessLogRetentionCronService — unit tests for orchestration logic
 * (task-file-storage-hardening MED-5, security-review round 1).
 *
 * The ACTUAL 365-day SQL boundary can only be verified against a real
 * Postgres — `lt(...)` is an opaque drizzle predicate here. This file covers
 * everything the service does around the query result: return-value
 * counting, and the outer try/catch never throwing (mirrors
 * vacancies-retention.cron.spec.ts's own split for the same reason).
 */
import { Logger } from '@nestjs/common'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseService } from '../database/database.service'
import {
  ACCESS_LOG_RETENTION_DAYS,
  DocumentAccessLogRetentionCronService,
} from './document-access-log-retention.cron'

function makeDb(deletedRows: { id: string }[]) {
  const deleteWhereCalls: unknown[] = []
  const db = {
    db: {
      delete: (_table: unknown) => ({
        where: (pred: unknown) => ({
          returning: async (_cols: unknown) => {
            deleteWhereCalls.push(pred)
            return deletedRows
          },
        }),
      }),
    },
  }
  return { db: db as unknown as DatabaseService, deleteWhereCalls }
}

describe('DocumentAccessLogRetentionCronService.purgeExpiredEntries', () => {
  it('returns the number of deleted rows', async () => {
    const { db } = makeDb([{ id: 'row-1' }, { id: 'row-2' }])
    const svc = new DocumentAccessLogRetentionCronService(db)

    const deleted = await svc.purgeExpiredEntries(new Date('2026-08-01'))
    expect(deleted).toBe(2)
  })

  it('returns 0 when nothing is expired', async () => {
    const { db } = makeDb([])
    const svc = new DocumentAccessLogRetentionCronService(db)

    const deleted = await svc.purgeExpiredEntries(new Date('2026-08-01'))
    expect(deleted).toBe(0)
  })

  it('exports a 365-day retention window (MED-5 reasoned default)', () => {
    expect(ACCESS_LOG_RETENTION_DAYS).toBe(365)
  })
})

describe('DocumentAccessLogRetentionCronService.handleRetention (the @Cron entrypoint)', () => {
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
    const { db } = makeDb([])
    const svc = new DocumentAccessLogRetentionCronService(db)

    await expect(svc.handleRetention()).resolves.toBeUndefined()
    expect(logSpy).toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('catches an unexpected error from purgeExpiredEntries, logs it, and does NOT rethrow', async () => {
    const db = {
      db: {
        delete: () => {
          throw new Error('DB connection lost')
        },
      },
    } as unknown as DatabaseService
    const svc = new DocumentAccessLogRetentionCronService(db)

    await expect(svc.handleRetention()).resolves.toBeUndefined()
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('retention cron failed'),
      expect.anything(),
    )
  })
})
