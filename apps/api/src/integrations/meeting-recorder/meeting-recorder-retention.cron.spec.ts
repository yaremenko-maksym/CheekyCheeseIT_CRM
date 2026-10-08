import { Logger } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'

import type { DatabaseService } from '../../database/database.service'
import {
  MEETING_RECORDER_WEBHOOK_RECEIPT_RETENTION_DAYS,
  meetingRecorderReceiptRetentionCutoff,
  MeetingRecorderRetentionCronService,
} from './meeting-recorder-retention.cron'

function dbReturning(rows: unknown[]) {
  const returning = vi.fn().mockResolvedValue(rows)
  const where = vi.fn().mockReturnValue({ returning })
  const deleteRows = vi.fn().mockReturnValue({ where })
  return {
    db: { db: { delete: deleteRows } } as unknown as DatabaseService,
    deleteRows,
    where,
    returning,
  }
}

describe('MeetingRecorderRetentionCronService', () => {
  it('uses an exact 30-day retention cutoff', () => {
    const now = new Date('2026-10-08T12:00:00.000Z')

    expect(MEETING_RECORDER_WEBHOOK_RECEIPT_RETENTION_DAYS).toBe(30)
    expect(meetingRecorderReceiptRetentionCutoff(now).toISOString()).toBe(
      '2026-09-08T12:00:00.000Z',
    )
  })

  it('deletes expired receipts and returns the affected row count', async () => {
    const ctx = dbReturning([{ id: 'one' }, { id: 'two' }])
    const service = new MeetingRecorderRetentionCronService(ctx.db)

    await expect(service.purgeExpiredReceipts(new Date('2026-10-08T12:00:00.000Z'))).resolves.toBe(
      2,
    )
    expect(ctx.deleteRows).toHaveBeenCalledOnce()
    expect(ctx.where).toHaveBeenCalledOnce()
    expect(ctx.returning).toHaveBeenCalledOnce()
  })

  it('logs the number of deleted receipts after a successful retention cycle', async () => {
    const service = new MeetingRecorderRetentionCronService(dbReturning([]).db)
    vi.spyOn(service, 'purgeExpiredReceipts').mockResolvedValue(3)
    const logger = (service as unknown as { logger: Logger }).logger
    const log = vi.spyOn(logger, 'log').mockImplementation(() => undefined)

    await expect(service.handleRetention()).resolves.toBeUndefined()

    expect(log).toHaveBeenCalledWith('Meeting Recorder receipt retention: deleted 3 row(s)')
  })

  it('logs failures and lets the next cron cycle retry', async () => {
    const service = new MeetingRecorderRetentionCronService(dbReturning([]).db)
    const failure = new Error('database unavailable')
    vi.spyOn(service, 'purgeExpiredReceipts').mockRejectedValue(failure)
    const logger = (service as unknown as { logger: Logger }).logger
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined)

    await expect(service.handleRetention()).resolves.toBeUndefined()

    expect(error).toHaveBeenCalledWith(
      'Meeting Recorder receipt retention cron failed; will retry next cycle',
      failure.stack,
    )
  })

  it('stringifies non-Error retention failures for logging', async () => {
    const service = new MeetingRecorderRetentionCronService(dbReturning([]).db)
    vi.spyOn(service, 'purgeExpiredReceipts').mockRejectedValue('database unavailable')
    const logger = (service as unknown as { logger: Logger }).logger
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined)

    await service.handleRetention()

    expect(error).toHaveBeenCalledWith(
      'Meeting Recorder receipt retention cron failed; will retry next cycle',
      'database unavailable',
    )
  })
})
