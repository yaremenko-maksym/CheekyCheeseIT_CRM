import { Logger } from '@nestjs/common'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseService } from '../database/database.service'
import {
  JOB_QUEUE_ACTION_PURGE_SQL,
  JobQueueActionRetentionCronService,
} from './job-queue-action-retention.cron'

/**
 * r5 Task 1.4a — the caller the purge function did not have.
 *
 * What a unit spec can and cannot prove here, stated so nothing is overclaimed:
 * it proves the CALLER (which statement, how the count is read, that a failure
 * never escapes the `@Cron` handler). It proves nothing about the two-year window
 * or the privileges — those are SQL, and the integration sibling
 * (`job-queue-action-retention.cron.integration.spec.ts`) exercises them against a
 * real catalog as `crm_app`.
 */

/** A `db.execute` stub returning whatever the purge function is said to have returned. */
function dbReturning(purged: unknown): { db: DatabaseService; executed: string[] } {
  const executed: string[] = []
  const db = {
    db: {
      execute: (query: { toString?: () => string } & Record<string, unknown>) => {
        // The SQL object is inspected through the template's own chunks so the test
        // reads the statement the driver would, not a re-serialisation of it.
        executed.push(JSON.stringify(query))
        return Promise.resolve({ rows: purged === undefined ? [] : [{ purged }] })
      },
    },
  } as unknown as DatabaseService
  return { db, executed }
}

describe('JobQueueActionRetentionCronService.purgeExpiredActions', () => {
  it('invokes crm_retention_purge_job_queue_actions() and nothing else', async () => {
    const { db, executed } = dbReturning('0')
    await new JobQueueActionRetentionCronService(db).purgeExpiredActions()

    expect(executed).toHaveLength(1)
    expect(executed[0]).toContain('crm_retention_purge_job_queue_actions')
  })

  it('carries no retention period of its own — the statement takes no argument', () => {
    // AC2: the two-year interval lives in the trigger body and the purge function,
    // both pinned by the catalog check's checksum. A third copy in TypeScript — even
    // as a parameter passed in — would defeat that pinning, so the statement must be
    // a bare, argument-free call. This asserts on the exported SQL text because that
    // is the only place a period could hide.
    expect(JOB_QUEUE_ACTION_PURGE_SQL).toBe(
      'SELECT public.crm_retention_purge_job_queue_actions() AS purged',
    )
    expect(JOB_QUEUE_ACTION_PURGE_SQL).not.toMatch(/year|month|day|interval/i)
  })

  it('reads the bigint count, which the driver hands back as a string', async () => {
    // `pg` returns bigint as a string; a missing Number() would make the logged
    // count a string and `purged > 0` a lexicographic comparison.
    const { db } = dbReturning('17')
    await expect(new JobQueueActionRetentionCronService(db).purgeExpiredActions()).resolves.toBe(17)
  })

  it('reports 0 when the function returns no row at all', async () => {
    const { db } = dbReturning(undefined)
    await expect(new JobQueueActionRetentionCronService(db).purgeExpiredActions()).resolves.toBe(0)
  })

  it('reports 0 rather than NaN when the value is null', async () => {
    const { db } = dbReturning(null)
    await expect(new JobQueueActionRetentionCronService(db).purgeExpiredActions()).resolves.toBe(0)
  })
})

describe('JobQueueActionRetentionCronService — the schedule itself', () => {
  it('the handler is scheduled daily at 04:15, which is what makes the purge live', () => {
    // THE CRUX OF THIS TASK, pinned. PR #1026 shipped the purge function with no
    // caller at all; a caller that is correct and never scheduled leaves it exactly
    // as inert. `@nestjs/schedule` records the slot as metadata ON THE METHOD
    // FUNCTION under this string key (measured — it is not on the prototype/key
    // pair), and deleting the `@Cron` line turns this case red.
    const handler = JobQueueActionRetentionCronService.prototype.handleRetention
    expect(Reflect.getMetadata('SCHEDULE_CRON_OPTIONS', handler)).toEqual({
      cronTime: '15 4 * * *',
    })
  })

  it('does not collide with another cron minute in this process', () => {
    // 03:00 / 03:30 / 03:45 / 04:00 are taken by the other retention jobs and 05:00
    // by the job-sourcing collection, which documents itself as running AFTER the
    // retention band. 04:15 is inside that band and held by nothing else.
    const taken = ['0 3 * * *', '30 3 * * *', '45 3 * * *', '0 4 * * *', '0 5 * * *']
    const ours = (
      Reflect.getMetadata(
        'SCHEDULE_CRON_OPTIONS',
        JobQueueActionRetentionCronService.prototype.handleRetention,
      ) as { cronTime: string }
    ).cronTime
    expect(taken).not.toContain(ours)
  })
})

describe('JobQueueActionRetentionCronService.handleRetention (the @Cron entrypoint)', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('logs the row count it deleted (AC1)', async () => {
    const svc = new JobQueueActionRetentionCronService({} as unknown as DatabaseService)
    vi.spyOn(svc, 'purgeExpiredActions').mockResolvedValue(42)

    await expect(svc.handleRetention()).resolves.toBeUndefined()
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('42'))
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('logs a count of 0 too — a legally required job must prove it ran', async () => {
    const svc = new JobQueueActionRetentionCronService({} as unknown as DatabaseService)
    vi.spyOn(svc, 'purgeExpiredActions').mockResolvedValue(0)

    await expect(svc.handleRetention()).resolves.toBeUndefined()
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('0'))
  })

  it('catches a thrown error, logs it, and does NOT rethrow (C-23)', async () => {
    // The scheduler-killing case: an unhandled rejection inside a `@Cron` handler
    // silently kills every OTHER cron in the process. `resolves` is the assertion
    // that matters here — making the catch rethrow turns this case red.
    const svc = new JobQueueActionRetentionCronService({} as unknown as DatabaseService)
    vi.spyOn(svc, 'purgeExpiredActions').mockRejectedValue(new Error('connection terminated'))

    await expect(svc.handleRetention()).resolves.toBeUndefined()
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('retention cron failed'),
      expect.anything(),
    )
  })

  it('survives a permission failure the same way (42501 is logged, not thrown)', async () => {
    // The shape a missing EXECUTE grant would take. It must look like an incident in
    // the log and like a no-op to the scheduler.
    const svc = new JobQueueActionRetentionCronService({} as unknown as DatabaseService)
    // `severity` as well as `code`: that is what makes it a driver error to
    // `findPgError`, and a fixture carrying only `code` would test nothing real.
    const denied = Object.assign(new Error('permission denied for function'), {
      code: '42501',
      severity: 'ERROR',
    })
    vi.spyOn(svc, 'purgeExpiredActions').mockRejectedValue(denied)

    await expect(svc.handleRetention()).resolves.toBeUndefined()
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('42501'), expect.anything())
  })
})
