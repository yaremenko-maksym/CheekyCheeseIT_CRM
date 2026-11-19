import { Logger } from '@nestjs/common'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JobSourceTriggerMode, JobSourceType } from '@crm/shared'
import type { HrAccessService } from '../common/hr-access.service'
import type { DatabaseService } from '../database/database.service'
import { jobSourceHealthEvents, jobSources } from '../database/schema'
import type { DouRssProvider } from './dou.provider'
import { SourceBlockedError } from './http/source-errors'
import { JobSourcingService } from './job-sourcing.service'

/**
 * task-sources-06-dou AC 3:
 * A 403 / cf-mitigated: challenge surfaces as a clear source health/readiness state
 * in the legacy loop (BLOCKED / ACCESS_CHANGED), never retried within the run.
 */

function makeRow(
  type: JobSourceType = 'DOU_RSS',
  triggerMode: JobSourceTriggerMode = 'BOTH',
  readiness: 'CANDIDATE' | 'VERIFIED' | 'BLOCKED' = 'CANDIDATE',
) {
  return { id: `id-${type}`, type, triggerMode, config: {}, enabled: true, readiness }
}

describe('JobSourcingService legacy loop DOU challenge health (AC 3)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('transitions source to BLOCKED readiness and records ACCESS_CHANGED health event on SourceBlockedError', async () => {
    const source = makeRow('DOU_RSS')
    const updateSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) })
    const insertValues = vi.fn().mockResolvedValue(undefined)

    const selectQuery = {
      from: () => ({
        where: () =>
          Object.assign(Promise.resolve([source]), {
            limit: () => Promise.resolve([]),
          }),
      }),
    }
    const db = {
      db: {
        select: () => selectQuery,
        update: vi.fn().mockReturnValue({ set: updateSet }),
        insert: vi.fn().mockReturnValue({ values: insertValues }),
      },
    } as unknown as DatabaseService

    const service = new JobSourcingService(
      db,
      {} as HrAccessService,
      { type: 'DOU_RSS' } as unknown as DouRssProvider,
    )

    const blockedError = new SourceBlockedError('jobs.dou.ua', 403)
    vi.spyOn(service, 'collectSource').mockRejectedValue(blockedError)

    const run = await service.collectAll('SCHEDULED')

    // 1. Swallowed and reported in failures
    expect(run.failures).toHaveLength(1)
    expect(run.failures[0]?.sourceType).toBe('DOU_RSS')
    expect(run.failures[0]?.budgetExhausted).toBe(false)

    // 2. Logged as warn (deliberate stop), not error
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Job collection blocked for source DOU_RSS'),
    )
    expect(errorSpy).not.toHaveBeenCalled()

    // 3. Updates jobSources readiness to BLOCKED
    expect(db.db.update).toHaveBeenCalledWith(jobSources)
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        readiness: 'BLOCKED',
        readinessReason: expect.stringContaining('jobs.dou.ua'),
      }),
    )

    // 4. Records TRANSITION health event to BLOCKED with ACCESS_CHANGED
    expect(db.db.insert).toHaveBeenCalledWith(jobSourceHealthEvents)
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: 'id-DOU_RSS',
        kind: 'TRANSITION',
        toState: 'BLOCKED',
        reasonCode: 'ACCESS_CHANGED',
        httpStatus: 403,
      }),
    )
  })

  it('excludes BLOCKED sources from legacy collection loop (terminal state, never retried)', async () => {
    const blockedSource = makeRow('DOU_RSS', 'BOTH', 'BLOCKED')
    const selectQuery = {
      from: () => ({
        where: () =>
          Object.assign(Promise.resolve([blockedSource]), {
            limit: () => Promise.resolve([]),
          }),
      }),
    }
    const db = {
      db: {
        select: () => selectQuery,
      },
    } as unknown as DatabaseService

    const service = new JobSourcingService(
      db,
      {} as HrAccessService,
      { type: 'DOU_RSS' } as unknown as DouRssProvider,
    )

    const collectSpy = vi.spyOn(service, 'collectSource')

    const run = await service.collectAll('SCHEDULED')

    expect(collectSpy).not.toHaveBeenCalled()
    expect(run.results).toHaveLength(0)
    expect(run.failures).toHaveLength(0)
  })
})
