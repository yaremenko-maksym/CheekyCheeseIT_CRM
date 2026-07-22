/**
 * VacanciesRetentionCronService — unit tests for orchestration logic (dedup,
 * return-value counting, R2-error isolation, outer try/catch never throwing).
 *
 * The ACTUAL 90-day SQL boundary (89/90/91 day fixtures) can only be verified
 * against a real Postgres — `lt(...)` is an opaque drizzle predicate here, so
 * a mocked DB cannot prove the WHERE clause is correct. That boundary +
 * idempotency (second run finds nothing to delete) are covered against a real
 * DB in vacancies.integration.spec.ts (AC9). This file covers everything the
 * service does AROUND the query result.
 */
import { Logger } from '@nestjs/common'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseService } from '../database/database.service'
import type { S3Service } from '../documents/s3.service'
import { VacanciesRetentionCronService } from './vacancies-retention.cron'

interface Candidate {
  id: string
  resumeS3Key: string
}

function makeDb(opts: { rejectedRows?: Candidate[]; closedVacancyRows?: Candidate[] }) {
  let selectCallCount = 0
  const deleteCalls: unknown[] = []

  const db = {
    db: {
      select: (_fields?: unknown) => ({
        from: (_table: unknown) => {
          selectCallCount += 1
          const isFirstCall = selectCallCount === 1
          return {
            where: async (_pred: unknown) => (isFirstCall ? (opts.rejectedRows ?? []) : []),
            innerJoin: (_t: unknown, _on: unknown) => ({
              where: async (_pred: unknown) => opts.closedVacancyRows ?? [],
            }),
          }
        },
      }),
      delete: (_table: unknown) => ({
        where: async (_pred: unknown) => {
          deleteCalls.push(_pred)
          return undefined
        },
      }),
    },
  }

  return { db: db as unknown as DatabaseService, getDeleteCallCount: () => deleteCalls.length }
}

describe('VacanciesRetentionCronService.purgeExpiredApplications', () => {
  it('returns 0 and issues no DB delete when nothing is expired', async () => {
    const { db, getDeleteCallCount } = makeDb({ rejectedRows: [], closedVacancyRows: [] })
    const s3 = { delete: vi.fn() }
    const svc = new VacanciesRetentionCronService(db, s3 as unknown as S3Service)

    const deleted = await svc.purgeExpiredApplications(new Date('2026-07-22'))
    expect(deleted).toBe(0)
    expect(getDeleteCallCount()).toBe(0)
    expect(s3.delete).not.toHaveBeenCalled()
  })

  it('deletes each candidate exactly once even when it matches BOTH criteria (dedup by id)', async () => {
    const shared: Candidate = { id: 'app-1', resumeS3Key: 'vacancy-applications/v1/app-1.pdf' }
    const { db, getDeleteCallCount } = makeDb({
      rejectedRows: [shared],
      closedVacancyRows: [shared],
    })
    const s3 = { delete: vi.fn().mockResolvedValue(undefined) }
    const svc = new VacanciesRetentionCronService(db, s3 as unknown as S3Service)

    const deleted = await svc.purgeExpiredApplications(new Date('2026-07-22'))
    expect(deleted).toBe(1)
    expect(getDeleteCallCount()).toBe(1)
    expect(s3.delete).toHaveBeenCalledTimes(1)
    expect(s3.delete).toHaveBeenCalledWith(shared.resumeS3Key)
  })

  it('merges rejected + closed-vacancy candidates and returns the combined count', async () => {
    const a: Candidate = { id: 'app-a', resumeS3Key: 'k-a' }
    const b: Candidate = { id: 'app-b', resumeS3Key: 'k-b' }
    const { db } = makeDb({ rejectedRows: [a], closedVacancyRows: [b] })
    const s3 = { delete: vi.fn().mockResolvedValue(undefined) }
    const svc = new VacanciesRetentionCronService(db, s3 as unknown as S3Service)

    const deleted = await svc.purgeExpiredApplications(new Date('2026-07-22'))
    expect(deleted).toBe(2)
    expect(s3.delete).toHaveBeenCalledTimes(2)
  })

  it('an R2 delete failure on one candidate leaves its DB row in place; the other candidate is still fully purged (F4 ordering)', async () => {
    const a: Candidate = { id: 'app-a', resumeS3Key: 'k-a' }
    const b: Candidate = { id: 'app-b', resumeS3Key: 'k-b' }
    const { db, getDeleteCallCount } = makeDb({ rejectedRows: [a, b] })
    const s3 = {
      delete: vi.fn().mockImplementation(async (key: string) => {
        if (key === 'k-a') throw new Error('R2 unreachable')
      }),
    }
    const svc = new VacanciesRetentionCronService(db, s3 as unknown as S3Service)

    const deleted = await svc.purgeExpiredApplications(new Date('2026-07-22'))
    // R2 delete now happens BEFORE the DB row delete, per candidate (F4 /
    // MED-4 fix): app-a's R2 delete failed, so its row is intentionally left
    // in place (retried on the next daily run) — only app-b (R2 delete
    // succeeded) is purged from the DB.
    expect(deleted).toBe(1)
    expect(getDeleteCallCount()).toBe(1)
    expect(s3.delete).toHaveBeenCalledTimes(2)
    expect(s3.delete).toHaveBeenCalledWith('k-a')
    expect(s3.delete).toHaveBeenCalledWith('k-b')
  })

  describe('handleRetention (the @Cron entrypoint)', () => {
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
      const { db } = makeDb({ rejectedRows: [], closedVacancyRows: [] })
      const s3 = { delete: vi.fn() }
      const svc = new VacanciesRetentionCronService(db, s3 as unknown as S3Service)

      await expect(svc.handleRetention()).resolves.toBeUndefined()
      expect(logSpy).toHaveBeenCalled()
      expect(errorSpy).not.toHaveBeenCalled()
    })

    it('catches an unexpected error from purgeExpiredApplications, logs it, and does NOT rethrow', async () => {
      const db = {
        db: {
          select: () => {
            throw new Error('DB connection lost')
          },
        },
      } as unknown as DatabaseService
      const s3 = { delete: vi.fn() }
      const svc = new VacanciesRetentionCronService(db, s3 as unknown as S3Service)

      await expect(svc.handleRetention()).resolves.toBeUndefined()
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('retention cron failed'),
        expect.anything(),
      )
    })
  })
})
