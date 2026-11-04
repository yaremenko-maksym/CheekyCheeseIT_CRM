import 'reflect-metadata'
import { Logger } from '@nestjs/common'
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  GENERATION_RETENTION_CRON,
  JobQueueGenerationRetentionCronService,
} from './job-queue-generation-retention.cron'

/** Unit double; the purge itself is pinned on Postgres by the queue integration spec. */
function harness(enabled: unknown, execute: (q: SQL) => Promise<{ rows: unknown[] }>) {
  const spy = vi.fn(execute)
  const get = vi.fn(() => enabled)
  const svc = new JobQueueGenerationRetentionCronService(
    { db: { execute: spy } } as never,
    { get } as never,
  )
  return { svc, execute: spy, get }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('JobQueueGenerationRetentionCronService', () => {
  it('runs daily at 04:25, on a minute no other cron holds', () => {
    expect(GENERATION_RETENTION_CRON).toBe('25 4 * * *')
    const handler = JobQueueGenerationRetentionCronService.prototype.handleRetention
    expect(Reflect.getMetadata('SCHEDULE_CRON_OPTIONS', handler)).toEqual({
      cronTime: '25 4 * * *',
    })
  })

  it.each([[false], [undefined], ['true']])('flag %j: the tick touches nothing', async (flag) => {
    const h = harness(flag, async () => ({ rows: [] }))
    await h.svc.handleRetention()
    expect(h.get).toHaveBeenCalledWith('JOB_QUEUE_GENERATION_PURGE_ENABLED', { infer: true })
    expect(h.execute).not.toHaveBeenCalled()
  })

  it('without a config service the tick touches nothing', async () => {
    const execute = vi.fn()
    const svc = new JobQueueGenerationRetentionCronService({ db: { execute } } as never)
    await svc.handleRetention()
    expect(execute).not.toHaveBeenCalled()
  })

  it('flag on: purges as of now and logs the count, zero included', async () => {
    const NOW = new Date('2026-11-04T04:25:00.000Z')
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
    const h = harness(true, async () => ({ rows: [{ id: 'a' }, { id: 'b' }] }))
    await h.svc.handleRetention()
    expect(h.execute).toHaveBeenCalledTimes(2)
    const first = new PgDialect().sqlToQuery(h.execute.mock.calls[0]?.[0] as SQL)
    expect(first.params).toEqual([NOW.toISOString(), NOW.toISOString()])
    expect(log).toHaveBeenCalledWith('Job queue generation retention: purged 2 generation(s)')
  })

  it('a failure is logged and never rethrown: it would kill the scheduler', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    const h = harness(true, async () => {
      throw new Error('connection lost')
    })
    await expect(h.svc.handleRetention()).resolves.toBeUndefined()
    expect(error).toHaveBeenCalledTimes(1)
    expect(String(error.mock.calls[0]?.[0])).toContain(
      'Job queue generation retention failed; will retry next tick',
    )
  })
})
