import { Logger } from '@nestjs/common'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseService } from '../database/database.service'
import {
  JOB_QUEUE_ACTION_PURGE_FAILURE_MARKER,
  JOB_QUEUE_ACTION_PURGE_SQL,
  JobQueueActionRetentionCronService,
} from './job-queue-action-retention.cron'

/** A value that must never appear in a log line. */
const SECRET = 'SECRET-VALUE-123'

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

  /**
   * WHICH OF THE TWO THE DRIVER CAN ACTUALLY PRODUCE, since the question decides what
   * these two cases are worth. `undefined` is the reachable one: it is what
   * `rows[0]?.purged` yields whenever the result carries no row, which is the shape a
   * failed or rewritten statement would hand back. A `null` VALUE is not reachable
   * through the shipped function — it is declared `RETURNS bigint` and `GET
   * DIAGNOSTICS` always assigns the row count, so it cannot return SQL NULL — but a
   * future `AS purged` over a different expression could, and `Number(null)` being 0
   * rather than NaN is a coincidence of JS worth having pinned either way. Both are
   * asserted; only the first is a real driver state today.
   */
  it('reports 0 rather than NaN when the result carries no row (the real NaN risk)', async () => {
    const { db } = dbReturning(undefined)
    await expect(new JobQueueActionRetentionCronService(db).purgeExpiredActions()).resolves.toBe(0)
  })

  it('reports 0 for a SQL NULL count (which JS numeric coercion already gives)', async () => {
    // Renamed in fix round 1: as "reports 0 rather than NaN when the value is null"
    // this case documented a risk it does not carry. `Number(null)` IS 0, so it passes
    // with or without any null handling — the NaN risk belongs to `undefined`, which
    // the case above owns. Kept, because the behaviour is worth stating; no longer
    // claiming to pin a guard it cannot pin.
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

  it('logs the SQLSTATE of a wrapped driver error, without the query parameters', async () => {
    // CR-M-3. The first version of this case used a FLAT error carrying `code` and
    // `severity`, which is not what production produces: drizzle rejects with a
    // `DrizzleQueryError` whose own `.code` is `undefined` and whose `.cause` is the
    // driver error holding the SQLSTATE. A fixture of the wrong shape would have gone
    // green while the real path logged `db_state=none`.
    //
    // This matters past tidiness: `42501` here is a security signal with an alert on
    // it (PR #1041), and an unasserted log path is how such a signal goes quiet. The
    // shape below mirrors the canonical fixture in
    // `database/swallowing-handlers-db-error-log.spec.ts`; THAT file is the repo-wide
    // registry of swallow-and-log handlers and this service should be added to its
    // CASES list — it is in another zone, so it is left as a follow-up rather than
    // edited here.
    const svc = new JobQueueActionRetentionCronService({} as unknown as DatabaseService)
    const driver = Object.assign(new Error('permission denied for function'), {
      severity: 'ERROR',
      code: '42501',
    })
    const wrapper = Object.assign(new Error(`Failed query: ${JOB_QUEUE_ACTION_PURGE_SQL}`), {
      query: JOB_QUEUE_ACTION_PURGE_SQL,
      params: [SECRET],
      cause: driver,
    })
    wrapper.name = 'DrizzleQueryError'
    vi.spyOn(svc, 'purgeExpiredActions').mockRejectedValue(wrapper)

    await expect(svc.handleRetention()).resolves.toBeUndefined()

    const [message, stack] = errorSpy.mock.calls[0] as [string, string | undefined]
    // The SQLSTATE reached the log, read through `.cause` rather than off the wrapper.
    expect(message).toContain('db_state=42501')
    // And no parameter value rode along, in either argument.
    expect(message).not.toContain(SECRET)
    expect(stack ?? '').not.toContain(SECRET)
  })

  it('marks EVERY failure with a greppable token, not only the one SQLSTATE with an alert', async () => {
    // SR-M-2. A `42883`, a lock timeout or a connection loss matches no alert pattern,
    // and since the handler never rethrows the failure would otherwise go nowhere at
    // all. Asserted on an error with NO SQLSTATE, which is the case that had no channel.
    const svc = new JobQueueActionRetentionCronService({} as unknown as DatabaseService)
    vi.spyOn(svc, 'purgeExpiredActions').mockRejectedValue(new Error('connection terminated'))

    await expect(svc.handleRetention()).resolves.toBeUndefined()

    // THE LITERAL, NOT THE IMPORTED CONSTANT, and that is the point rather than an
    // oversight. Asserting `stringContaining(JOB_QUEUE_ACTION_PURGE_FAILURE_MARKER)`
    // takes the expected value from the very code under test, so emptying the constant
    // left the assertion passing — a tautological test, and the mutation gate caught it
    // as a surviving `StringLiteral` mutant (fix round 1). An alert pattern will be
    // written against this exact token, so the token is what the test must state.
    const [message] = errorSpy.mock.calls[0] as [string]
    expect(message).toContain('crm_retention_purge_failed')
    // And the exported constant is the same token, so the pattern DevOps writes against
    // one of them matches the other.
    expect(JOB_QUEUE_ACTION_PURGE_FAILURE_MARKER).toBe('crm_retention_purge_failed')
  })
})
