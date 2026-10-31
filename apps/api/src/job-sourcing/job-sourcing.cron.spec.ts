import { createRequire } from 'node:module'
import { jobSourceTypeSchema } from '@crm/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  API_COLLECTION_CRON,
  API_COLLECTION_TYPES,
  HTML_COLLECTION_CRON,
  HTML_COLLECTION_TYPES,
  DEFAULT_WINDOW_INTERVAL_MS,
  JobSourcingCronService,
  SWEEP_CRON,
  TICK_CRON,
  TICK_WINDOW_MS,
  tickTriggerKey,
} from './job-sourcing.cron'
import { DEFAULT_JOB_COLLECTION_WINDOW_MS } from '../config/env'
import { SWEEP_RECENT_RUN_MS } from './ownership/job-run-ledger'

/**
 * r5 Task 2.5 T5, the pure side: decorators, the cron expressions resolved in Europe/Kyiv across
 * both 2027 transitions (an injected `from` instant), step isolation, type sets, trigger keys. The
 * real-Postgres cases are in `job-sourcing.cron.integration.spec.ts`.
 */
// `cron` is @nestjs/schedule's own dependency: resolved from there, not added to this package.
const { CronTime } = createRequire(createRequire(import.meta.url).resolve('@nestjs/schedule'))(
  'cron',
) as {
  CronTime: new (
    expr: string,
    zone: string,
  ) => { getNextDateFrom(from: Date, zone: string): { toUTC(): { toISO(): string } } }
}

const OPTIONS_KEY = 'SCHEDULE_CRON_OPTIONS'
const proto = JobSourcingCronService.prototype
const optionsOf = (fn: unknown) =>
  Reflect.getMetadata(OPTIONS_KEY, fn as object) as { cronTime: string; timeZone: string }

/**
 * The next fire time of a handler, computed from ITS OWN decorator options (expression and zone)
 * and an explicit `from` instant. The zone is passed to the library so the result does not depend
 * on the host's timezone (`getNextDateFrom(date)` alone resolves in the HOST zone).
 */
function nextUtc(handler: unknown, from: string): string {
  const { cronTime, timeZone } = optionsOf(handler)
  return new CronTime(cronTime, timeZone).getNextDateFrom(new Date(from), timeZone).toUTC().toISO()
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('schedules (AC 1)', () => {
  it('every decorator carries Europe/Kyiv and its own expression', () => {
    expect(optionsOf(proto.handleDailyCollection)).toMatchObject({
      cronTime: '0 5 * * *',
      timeZone: 'Europe/Kyiv',
    })
    expect(optionsOf(proto.handleHtmlCollection)).toMatchObject({
      cronTime: '30 2 * * *',
      timeZone: 'Europe/Kyiv',
    })
    // source fetch strategy U3 AC 1
    expect(optionsOf(proto.handleTick)).toMatchObject({
      cronTime: '*/10 * * * *',
      timeZone: 'Europe/Kyiv',
    })
    expect(optionsOf(proto.handleSweep)).toMatchObject({
      cronTime: '0 8 * * *',
      timeZone: 'Europe/Kyiv',
    })
    expect([API_COLLECTION_CRON, HTML_COLLECTION_CRON, TICK_CRON, SWEEP_CRON]).toEqual([
      '0 5 * * *',
      '30 2 * * *',
      '*/10 * * * *',
      '0 8 * * *',
    ])
  })

  it('U3: the sweep fires at 08:00 Kyiv across both 2027 transitions; the tick every 10 minutes', () => {
    // winter 08:00 EET = 06:00Z; after the spring jump 08:00 EEST = 05:00Z; after fall-back EET again
    expect(nextUtc(proto.handleSweep, '2027-01-10T12:00:00Z')).toBe('2027-01-11T06:00:00.000Z')
    expect(nextUtc(proto.handleSweep, '2027-03-27T12:00:00Z')).toBe('2027-03-28T05:00:00.000Z')
    expect(nextUtc(proto.handleSweep, '2027-10-30T12:00:00Z')).toBe('2027-10-31T06:00:00.000Z')
    expect(nextUtc(proto.handleTick, '2027-07-10T12:03:00Z')).toBe('2027-07-10T12:10:00.000Z')
    expect(nextUtc(proto.handleTick, '2027-07-10T12:10:00Z')).toBe('2027-07-10T12:20:00.000Z')
  })

  it('resolves in Kyiv local time across both 2027 transitions (EET +2, EEST +3)', () => {
    // winter: 02:30 EET = 00:30Z, 05:00 EET = 03:00Z
    expect(nextUtc(proto.handleHtmlCollection, '2027-01-10T12:00:00Z')).toBe(
      '2027-01-11T00:30:00.000Z',
    )
    expect(nextUtc(proto.handleDailyCollection, '2027-01-10T12:00:00Z')).toBe(
      '2027-01-11T03:00:00.000Z',
    )
    // 2027-03-28: Kyiv jumps 03:00 -> 04:00; 02:30 still exists (EET), 05:00 is EEST (+3)
    expect(nextUtc(proto.handleHtmlCollection, '2027-03-27T12:00:00Z')).toBe(
      '2027-03-28T00:30:00.000Z',
    )
    expect(nextUtc(proto.handleDailyCollection, '2027-03-27T12:00:00Z')).toBe(
      '2027-03-28T02:00:00.000Z',
    )
    // summer: 02:30 EEST = 23:30Z the day before
    expect(nextUtc(proto.handleHtmlCollection, '2027-07-10T12:00:00Z')).toBe(
      '2027-07-10T23:30:00.000Z',
    )
    // 2027-10-31: Kyiv falls back 04:00 -> 03:00; 02:30 is EEST (+3), 05:00 is EET (+2)
    expect(nextUtc(proto.handleHtmlCollection, '2027-10-30T12:00:00Z')).toBe(
      '2027-10-30T23:30:00.000Z',
    )
    expect(nextUtc(proto.handleDailyCollection, '2027-10-30T12:00:00Z')).toBe(
      '2027-10-31T03:00:00.000Z',
    )
  })
})

describe('type sets', () => {
  it('HTML types go to 02:30, every other reporting type to the tick and the sweep, DOU to neither', () => {
    expect(HTML_COLLECTION_TYPES.length).toBeGreaterThan(0)
    expect(HTML_COLLECTION_TYPES.every((t) => t.endsWith('_HTML'))).toBe(true)
    expect(API_COLLECTION_TYPES).not.toContain('DOU_RSS')
    expect(API_COLLECTION_TYPES.some((t) => t.endsWith('_HTML'))).toBe(false)
    expect([...API_COLLECTION_TYPES, ...HTML_COLLECTION_TYPES, 'DOU_RSS'].sort()).toEqual(
      [...jobSourceTypeSchema.options].sort(),
    )
  })
})

function build(over: {
  openCycle?: () => Promise<{ cycleId: string }>
  recoverExpired?: () => Promise<number>
  sweep?: () => Promise<number>
  collectAll?: () => Promise<unknown>
  windowMs?: number
  countDue?: number
}) {
  const calls: string[] = []
  const ledger = {
    openCycle: vi.fn(async (i: { triggerKey: string }) => {
      calls.push(`open:${i.triggerKey}`)
      return over.openCycle ? over.openCycle() : { cycleId: 'cyc-1' }
    }),
    recoverExpired: vi.fn(async () => {
      calls.push('recover')
      return over.recoverExpired ? over.recoverExpired() : 0
    }),
    sweepOrphanReservations: vi.fn(async () => {
      calls.push('sweep')
      return over.sweep ? over.sweep() : 0
    }),
    closeCycle: vi.fn(async () => {
      calls.push('close')
      return true
    }),
    countDue: vi.fn(async (_i: { lookaheadMs?: number }) => over.countDue ?? 0),
  }
  const worker = {
    startDue: vi.fn(async (i: { onlyTypes: readonly string[]; sweep?: unknown }) => {
      calls.push(`claim:${i.onlyTypes[0]}${i.sweep === undefined ? '' : ':sweep'}`)
      return { claimed: 0, refused: [], settled: Promise.resolve([]) }
    }),
    activeRuns: 0,
  }
  const service = {
    collectAll: vi.fn(async () => {
      calls.push('dou')
      if (over.collectAll) return over.collectAll()
      return { results: [], failures: [] }
    }),
    purgeStalePostings: vi.fn(async () => 0),
  }
  const config = { get: () => over.windowMs ?? 200 }
  const svc = new JobSourcingCronService(
    service as never,
    ledger as never,
    worker as never,
    config as never,
  )
  return { svc, ledger, worker, service, calls }
}

describe('the 05:00 handler (narrowed by U3)', () => {
  it('U3 AC 1: runs the legacy DOU collection and retention only: no cycle, no claim of any type', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2027-10-31T03:00:00Z') })
    const b = build({})
    await b.svc.handleDailyCollection()
    expect(b.calls).toEqual(['dou'])
    expect(b.service.purgeStalePostings).toHaveBeenCalledTimes(1)
    expect(b.worker.startDue).not.toHaveBeenCalled()
    expect(b.ledger.openCycle).not.toHaveBeenCalled()
    expect(b.ledger.closeCycle).not.toHaveBeenCalled()
  })

  it('a throwing DOU collection is logged, never rethrown', async () => {
    const b = build({ collectAll: () => Promise.reject(new Error('boom')) })
    await expect(b.svc.handleDailyCollection()).resolves.toBeUndefined()
    expect(b.worker.startDue).not.toHaveBeenCalled()
  })

  it('without a ledger it collects DOU only, as before T5', async () => {
    const service = {
      collectAll: vi.fn().mockResolvedValue({ results: [], failures: [] }),
      purgeStalePostings: vi.fn().mockResolvedValue(0),
    }
    await new JobSourcingCronService(service as never).handleDailyCollection()
    expect(service.collectAll).toHaveBeenCalledWith()
    expect(service.purgeStalePostings).toHaveBeenCalledTimes(1)
  })
})

describe('the tick (U3)', () => {
  it('runs open -> recover -> sweepOrphans -> window (API types) -> close, keyed by the 10-minute Kyiv slot', async () => {
    // 2027-07-10 12:17Z = 15:17 EEST: the slot is 15:10
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2027-07-10T12:17:30Z') })
    const b = build({})
    await b.svc.handleTick()
    expect(b.calls).toEqual([
      'open:tick:2027-07-10T15:10',
      'recover',
      'sweep',
      'recover',
      `claim:${API_COLLECTION_TYPES[0]}`,
      'close',
    ])
    expect(b.service.collectAll).not.toHaveBeenCalled()
  })

  it('CR-M-3: the sweep`s recent-run window is one tick period plus one tick window', () => {
    expect(SWEEP_RECENT_RUN_MS).toBe(10 * 60_000 + TICK_WINDOW_MS)
  })

  it('its window is 9 minutes, whatever JOB_COLLECTION_WINDOW_MS says', async () => {
    expect(TICK_WINDOW_MS).toBe(9 * 60_000)
    const b = build({ windowMs: 3_600_000 })
    await b.svc.handleTick()
    const lookahead = b.ledger.countDue.mock.calls[0]?.[0]?.lookaheadMs ?? -1
    expect(lookahead).toBeGreaterThan(TICK_WINDOW_MS - 1_000)
    expect(lookahead).toBeLessThanOrEqual(TICK_WINDOW_MS)
  })

  it('U3 AC 2: a tick ends within 9 minutes while work stays due (fake monotonic clock)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] })
    const b = build({ countDue: 5 }) // always due, never claimable
    let done = false
    const run = b.svc.handleTick().then(() => {
      done = true
    })
    await vi.advanceTimersByTimeAsync(TICK_WINDOW_MS - 1_000)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000)
    await run
    expect(done).toBe(true)
    expect(b.ledger.closeCycle).toHaveBeenCalledTimes(1)
    // a pass every 30 s for 9 minutes: 18 claims, not one more
    expect(b.worker.startDue).toHaveBeenCalledTimes(18)
  })

  it('a throwing step never rejects the tick, and later steps still run', async () => {
    const boom = () => Promise.reject(new Error('boom'))
    for (const over of [{ openCycle: boom }, { recoverExpired: boom }, { sweep: boom }]) {
      const b = build(over)
      await expect(b.svc.handleTick()).resolves.toBeUndefined()
      expect(b.calls).toContain('sweep')
    }
  })

  it('the slot key floors to 10 minutes on the Kyiv clock; the repeated fall-back hour reuses its key', () => {
    expect(tickTriggerKey(new Date('2027-07-10T12:19:59.999Z'))).toBe('tick:2027-07-10T15:10')
    expect(tickTriggerKey(new Date('2027-07-10T12:20:00.000Z'))).toBe('tick:2027-07-10T15:20')
    // 21:00Z on 2027-01-10 is 23:00 EET; 22:05Z is 00:05 the next Kyiv day
    expect(tickTriggerKey(new Date('2027-01-10T21:59:00Z'))).toBe('tick:2027-01-10T23:50')
    expect(tickTriggerKey(new Date('2027-01-10T22:05:00Z'))).toBe('tick:2027-01-11T00:00')
    // 2027-10-31: 03:13 EEST (00:13Z) and 03:13 EET (01:13Z) are the same local slot. The second
    // tick finds its cycle closed and claims nothing (A1: harmless, once a year, at night).
    expect(tickTriggerKey(new Date('2027-10-31T00:13:00Z'))).toBe('tick:2027-10-31T03:10')
    expect(tickTriggerKey(new Date('2027-10-31T01:13:00Z'))).toBe('tick:2027-10-31T03:10')
  })

  it('U4: runs the health detector pass once at the end of the tick window, and the sweep does not', async () => {
    const b = build({})
    const runDetectorPass = vi.fn(async () => ({ sources: 0, eventsWritten: 0 }))
    const svc = new JobSourcingCronService(
      b.service as never,
      b.ledger as never,
      b.worker as never,
      { get: () => 200 } as never,
      { runDetectorPass } as never,
    )
    await svc.handleTick()
    expect(runDetectorPass).toHaveBeenCalledTimes(1)
    await svc.handleSweep()
    expect(runDetectorPass).toHaveBeenCalledTimes(1) // the pass is tick-only, not the sweep
  })
})

describe('the 08:00 sweep (U3)', () => {
  it('runs open -> recover -> sweepOrphans -> window in SWEEP mode (API types) -> close, keyed by the Kyiv date', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2027-03-28T05:00:00Z') })
    const b = build({})
    await b.svc.handleSweep()
    expect(b.calls).toEqual([
      'open:sweep:2027-03-28',
      'recover',
      'sweep',
      'recover',
      `claim:${API_COLLECTION_TYPES[0]}:sweep`,
      'close',
    ])
    expect(b.service.collectAll).not.toHaveBeenCalled()
  })

  it('its window is JOB_COLLECTION_WINDOW_MS', async () => {
    const b = build({ windowMs: 200 })
    await b.svc.handleSweep()
    const lookahead = b.ledger.countDue.mock.calls[0]?.[0]?.lookaheadMs ?? -1
    expect(lookahead).toBeGreaterThan(0)
    expect(lookahead).toBeLessThanOrEqual(200)
  })

  it('a throwing step never rejects the sweep, and is named in the log', async () => {
    const b = build({ openCycle: () => Promise.reject(new Error('boom')) })
    const errors = vi
      .spyOn((b.svc as unknown as { logger: { error: () => void } }).logger, 'error')
      .mockImplementation(() => undefined)
    await expect(b.svc.handleSweep()).resolves.toBeUndefined()
    expect(errors.mock.calls.map((c) => String(c[0]))).toContainEqual(
      expect.stringMatching(/^Job sourcing cron step failed \[sweep: openCycle\]/),
    )
    expect(b.worker.startDue).not.toHaveBeenCalled()
    expect(b.calls).toContain('sweep')
  })
})

describe('the 02:30 handler', () => {
  it('claims HTML types only, never touches DOU, and uses its own trigger key', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2027-03-28T00:30:00Z') })
    const b = build({})
    await b.svc.handleHtmlCollection()
    expect(b.service.collectAll).not.toHaveBeenCalled()
    expect(b.calls).toEqual([
      'open:daily-html:2027-03-28',
      'recover',
      'sweep',
      'recover',
      `claim:${HTML_COLLECTION_TYPES[0]}`,
      'close',
    ])
  })

  it('a throwing step never rejects the handler', async () => {
    const b = build({ recoverExpired: () => Promise.reject(new Error('boom')) })
    await expect(b.svc.handleHtmlCollection()).resolves.toBeUndefined()
    expect(b.ledger.sweepOrphanReservations).toHaveBeenCalledTimes(1)
  })
})

describe('window length from config', () => {
  const windowOf = (value: unknown, withConfig = true) => {
    const get = vi.fn(() => value)
    const svc = new JobSourcingCronService(
      {} as never,
      undefined,
      undefined,
      withConfig ? ({ get } as never) : undefined,
    )
    return { ms: (svc as unknown as { windowMs(): number }).windowMs(), get }
  }

  it('reads JOB_COLLECTION_WINDOW_MS with the typed-read option and uses a positive finite number', () => {
    const { ms, get } = windowOf(1_234)
    expect(ms).toBe(1_234)
    expect(get).toHaveBeenCalledWith('JOB_COLLECTION_WINDOW_MS', { infer: true })
  })

  it('anything else is the default: no config, undefined, zero, negative, NaN, Infinity, a string', () => {
    const d = DEFAULT_JOB_COLLECTION_WINDOW_MS
    expect(windowOf(1, false).ms).toBe(d)
    for (const bad of [undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY, '5000', null]) {
      expect(windowOf(bad).ms).toBe(d)
    }
  })

  it('the wait between claims defaults to 30 s', () => {
    const svc = new JobSourcingCronService({} as never)
    expect(DEFAULT_WINDOW_INTERVAL_MS).toBe(30_000)
    expect(svc.tuning.intervalMs).toBe(30_000)
  })
})

describe('the trigger key', () => {
  it('is the schedule name and the KYIV calendar date, whatever the server`s zone', async () => {
    // A host whose default zone is far from Kyiv: a formatter built without an explicit zone
    // would name the wrong day at 10:30 UTC (13:30 Kyiv, 00:30 the next day on Kiritimati).
    const RealFormat = Intl.DateTimeFormat
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (
      locale?: string | string[],
      options?: Intl.DateTimeFormatOptions,
    ) {
      return new RealFormat(locale, {
        ...options,
        timeZone: options?.timeZone ?? 'Pacific/Kiritimati',
      })
    } as never)
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2027-06-30T10:30:00Z') })
    const b = build({})
    await b.svc.handleHtmlCollection()
    expect(b.ledger.openCycle).toHaveBeenCalledTimes(1)
    expect(b.ledger.openCycle.mock.calls[0]?.[0]).toStrictEqual({
      trigger: 'SCHEDULED',
      triggerKey: 'daily-html:2027-06-30',
    })
    vi.restoreAllMocks()
  })
})

describe('step failures are named in the log', () => {
  const boom = () => Promise.reject(new Error('boom'))
  const errorsOf = (svc: JobSourcingCronService) =>
    vi
      .spyOn((svc as unknown as { logger: { error: () => void } }).logger, 'error')
      .mockImplementation(() => undefined)

  it('openCycle, recoverExpired and sweepOrphanReservations each say which step failed', async () => {
    const b = build({ openCycle: boom, recoverExpired: boom, sweep: boom })
    const errors = errorsOf(b.svc)
    await b.svc.handleTick()
    const first = errors.mock.calls.map((c) => String(c[0]))
    expect(first).toContainEqual(
      expect.stringMatching(/^Job sourcing cron step failed \[tick: openCycle\]/),
    )
    expect(first).toContainEqual(expect.stringMatching(/\[tick: recoverExpired\]/))
    expect(first).toContainEqual(expect.stringMatching(/\[tick: sweepOrphanReservations\]/))
  })

  it('a window that escapes its own guards is caught and named, not rethrown', async () => {
    const b = build({})
    const logger = (b.svc as unknown as { logger: { log: () => void } }).logger
    vi.spyOn(logger, 'log').mockImplementation(() => {
      throw new Error('log sink down')
    })
    const errors = errorsOf(b.svc)
    await expect(b.svc.handleHtmlCollection()).resolves.toBeUndefined()
    expect(errors.mock.calls.map((c) => String(c[0]))).toContainEqual(
      expect.stringMatching(/\[daily-html: collection window\]/),
    )
  })
})

describe('the handler arguments are computed inside the step guard (review LOW)', () => {
  it('a config read that throws never rejects the sweep or the 02:30 handler; nothing is claimed', async () => {
    const b = build({})
    const svc = new JobSourcingCronService(
      b.service as never,
      b.ledger as never,
      b.worker as never,
      {
        get: () => {
          throw new Error('config down')
        },
      } as never,
    )
    vi.spyOn(
      (svc as unknown as { logger: { error: () => void } }).logger,
      'error',
    ).mockImplementation(() => undefined)
    await expect(svc.handleSweep()).resolves.toBeUndefined()
    await expect(svc.handleHtmlCollection()).resolves.toBeUndefined()
    expect(b.worker.startDue).not.toHaveBeenCalled()
  })

  it('a trigger key that cannot be computed never rejects any ledger handler', async () => {
    const b = build({})
    vi.spyOn(
      (b.svc as unknown as { logger: { error: () => void } }).logger,
      'error',
    ).mockImplementation(() => undefined)
    // the tick's formatter is built at module load: break its method, then the constructor
    vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts').mockImplementation(() => {
      throw new RangeError('no tz data')
    })
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function () {
      throw new RangeError('no tz data')
    } as never)
    await expect(b.svc.handleSweep()).resolves.toBeUndefined()
    await expect(b.svc.handleHtmlCollection()).resolves.toBeUndefined()
    await expect(b.svc.handleTick()).resolves.toBeUndefined()
    expect(b.ledger.openCycle).not.toHaveBeenCalled()
  })
})

describe('the window needs a ledger AND a worker AND a cycle', () => {
  it('ledger without a worker: cycle opened and recovery run, but no window and no close', async () => {
    const b = build({})
    const svc = new JobSourcingCronService(b.service as never, b.ledger as never)
    const errors = vi
      .spyOn((svc as unknown as { logger: { error: () => void } }).logger, 'error')
      .mockImplementation(() => undefined)
    await svc.handleHtmlCollection()
    expect(b.ledger.openCycle).toHaveBeenCalledTimes(1)
    expect(b.ledger.recoverExpired).toHaveBeenCalledTimes(1)
    expect(b.ledger.closeCycle).not.toHaveBeenCalled()
    // skipped on purpose, not attempted and failed
    expect(errors).not.toHaveBeenCalled()
  })

  it('a worker without a ledger does nothing and does not throw', async () => {
    const b = build({})
    const svc = new JobSourcingCronService(b.service as never, undefined, b.worker as never)
    const errors = vi
      .spyOn((svc as unknown as { logger: { error: () => void } }).logger, 'error')
      .mockImplementation(() => undefined)
    await expect(svc.handleHtmlCollection()).resolves.toBeUndefined()
    await expect(svc.handleTick()).resolves.toBeUndefined()
    expect(b.worker.startDue).not.toHaveBeenCalled()
    expect(errors).not.toHaveBeenCalled()
  })

  it('a cycle that failed to open with a worker present: no window, nothing logged beyond the open', async () => {
    const b = build({ openCycle: () => Promise.reject(new Error('boom')) })
    const errors = vi
      .spyOn((b.svc as unknown as { logger: { error: () => void } }).logger, 'error')
      .mockImplementation(() => undefined)
    await b.svc.handleTick()
    expect(errors).toHaveBeenCalledTimes(1)
    expect(b.worker.startDue).not.toHaveBeenCalled()
  })
})
