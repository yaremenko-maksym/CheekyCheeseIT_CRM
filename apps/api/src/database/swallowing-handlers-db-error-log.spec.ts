/**
 * AC1 + AC4 on every swallow-and-log cron handler: a database error that the handler
 * deliberately swallows must still reach the log WITH its SQLSTATE (read through
 * `.cause`), and must NOT carry the query's parameter values.
 *
 * Each case makes the handler's inner database call reject with the exact shape
 * drizzle produces — a `DrizzleQueryError` whose message embeds the values and whose
 * `.cause` is the driver error holding `42501`. The shape is hand-built here because
 * this file is about each handler's WIRING; that the shape matches what a real driver
 * produces is proven against a real Postgres in `pg-errors-log.integration.spec.ts`.
 *
 * "The handler still does not crash" is asserted for every case: the handler must
 * RESOLVE. The control flow of the handlers is unchanged by this task.
 */
import { Logger } from '@nestjs/common'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MeetingRecorderRetentionCronService } from '../integrations/meeting-recorder/meeting-recorder-retention.cron'
import { ResumeExtractionCronService } from '../resumes/resume-extraction.cron'
import { JobSourcingCronService } from '../job-sourcing/job-sourcing.cron'
import { SalaryCronService } from '../finance/salary-cron.service'
import { TelemetryRetentionCronService } from '../telemetry/telemetry-retention.cron'
import { DocumentAccessLogRetentionCronService } from '../documents/document-access-log-retention.cron'
import { NotificationEmailCronService } from '../notifications/notification-email.cron'
import { VacanciesRetentionCronService } from '../vacancies/vacancies-retention.cron'

const SECRET = 'SECRET-VALUE-123'

function deniedQueryError(): Error {
  const driver = Object.assign(new Error('permission denied for table some_table'), {
    severity: 'ERROR',
    code: '42501',
  })
  const wrapper = Object.assign(
    new Error(`Failed query: delete from "some_table" where "x" < $1\nparams: ${SECRET}`),
    { query: 'delete from "some_table" where "x" < $1', params: [SECRET], cause: driver },
  )
  wrapper.name = 'DrizzleQueryError'
  wrapper.stack = `DrizzleQueryError: ${wrapper.message}\n    at Handler.run (/x/handler.ts:1:1)`
  return wrapper
}

interface Case {
  name: string
  /** Builds the service, makes its inner DB call reject, and returns the handler to await. */
  arrange: (failure: Error) => () => Promise<void>
  /** This handler has always logged a message only, with no stack argument. */
  messageOnly?: true
}

const config = { get: () => 'https://landing.example' } as never

const CASES: Case[] = [
  {
    name: 'MeetingRecorderRetentionCronService.handleRetention',
    arrange: (failure) => {
      const svc = new MeetingRecorderRetentionCronService({} as never)
      vi.spyOn(svc, 'purgeExpiredReceipts').mockRejectedValue(failure)
      return () => svc.handleRetention()
    },
  },
  {
    name: 'ResumeExtractionCronService.handleStuckExtractions',
    messageOnly: true,
    arrange: (failure) => {
      const svc = new ResumeExtractionCronService({
        sweepStuckExtractions: vi.fn().mockRejectedValue(failure),
      } as never)
      return () => svc.handleStuckExtractions()
    },
  },
  {
    name: 'JobSourcingCronService.handleDailyCollection',
    arrange: (failure) => {
      const svc = new JobSourcingCronService({
        collectAll: vi.fn().mockRejectedValue(failure),
      } as never)
      return () => svc.handleDailyCollection()
    },
  },
  {
    name: 'SalaryCronService.handleMonthlySalaries',
    arrange: (failure) => {
      const svc = new SalaryCronService({
        createMonthlySalaries: vi.fn().mockRejectedValue(failure),
      } as never)
      return () => svc.handleMonthlySalaries()
    },
  },
  {
    name: 'TelemetryRetentionCronService.handleRetention',
    arrange: (failure) => {
      const svc = new TelemetryRetentionCronService({} as never)
      vi.spyOn(svc, 'purgeExpired').mockRejectedValue(failure)
      return () => svc.handleRetention()
    },
  },
  {
    name: 'DocumentAccessLogRetentionCronService.handleRetention',
    arrange: (failure) => {
      const svc = new DocumentAccessLogRetentionCronService({} as never)
      vi.spyOn(svc, 'purgeExpiredEntries').mockRejectedValue(failure)
      return () => svc.handleRetention()
    },
  },
  {
    name: 'NotificationEmailCronService.handleDue',
    arrange: (failure) => {
      const svc = new NotificationEmailCronService({} as never, {} as never, {} as never, config)
      vi.spyOn(svc, 'drainOnce').mockRejectedValue(failure)
      return () => svc.handleDue()
    },
  },
  {
    name: 'VacanciesRetentionCronService.handleRetention',
    arrange: (failure) => {
      const svc = new VacanciesRetentionCronService({} as never, {} as never, {} as never, config)
      vi.spyOn(svc, 'purgeExpiredApplications').mockRejectedValue(failure)
      return () => svc.handleRetention()
    },
  },
  {
    name: 'VacanciesRetentionCronService.handleWeeklyIndexingRefresh',
    arrange: (failure) => {
      const svc = new VacanciesRetentionCronService({} as never, {} as never, {} as never, config)
      vi.spyOn(svc, 'refreshPublishedIndexing').mockRejectedValue(failure)
      return () => svc.handleWeeklyIndexingRefresh()
    },
  },
]

describe('swallow-and-log cron handlers record a database error’s SQLSTATE and no values', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each(CASES)('$name', async ({ arrange }) => {
    const run = arrange(deniedQueryError())

    await expect(run()).resolves.toBeUndefined() // still swallowed

    expect(errorSpy).toHaveBeenCalledTimes(1)
    const args = errorSpy.mock.calls[0] as unknown[]
    const message = String(args[0])
    expect(message).toContain('db_error db_state=42501')
    expect(message).not.toContain('permission denied')
    // No value anywhere in what was handed to the logger — message OR stack argument.
    expect(JSON.stringify(args)).not.toContain(SECRET)
  })

  it.each(CASES.filter((c) => c.messageOnly !== true))(
    '$name keeps the stack frames, so the failure is still locatable',
    async ({ arrange }) => {
      await arrange(deniedQueryError())()

      const args = errorSpy.mock.calls[0] as unknown[]
      expect(String(args[1])).toContain('at Handler.run (/x/handler.ts:1:1)')
    },
  )

  it('a non-database error is logged exactly as before — no fragment, original stack', async () => {
    const svc = new DocumentAccessLogRetentionCronService({} as never)
    const plain = new Error('plain failure')
    plain.stack = 'Error: plain failure\n    at somewhere (/x.ts:1:1)'
    vi.spyOn(svc, 'purgeExpiredEntries').mockRejectedValue(plain)

    await svc.handleRetention()

    expect(errorSpy).toHaveBeenCalledWith(
      'Document access log retention cron failed — will retry next cycle',
      'Error: plain failure\n    at somewhere (/x.ts:1:1)',
    )
  })
})

describe('ResumeExtractionCronService keeps its message-only shape for non-database errors', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each([
    [new Error('disk on fire'), 'Resume extraction sweep failed: disk on fire'],
    ['not an Error', 'Resume extraction sweep failed: unknown error'],
  ])('%s', async (thrown, expected) => {
    const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    const svc = new ResumeExtractionCronService({
      sweepStuckExtractions: vi.fn().mockRejectedValue(thrown),
    } as never)

    await svc.handleStuckExtractions()

    expect(errorSpy).toHaveBeenCalledWith(expected)
  })
})
