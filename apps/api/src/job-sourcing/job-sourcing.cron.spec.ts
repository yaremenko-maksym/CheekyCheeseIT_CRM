import { createRequire } from 'node:module'
import { jobSourceTypeSchema } from '@crm/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  API_COLLECTION_CRON,
  API_COLLECTION_TYPES,
  CRON_TIME_ZONE,
  HTML_COLLECTION_CRON,
  HTML_COLLECTION_TYPES,
  DEFAULT_WINDOW_INTERVAL_MS,
  JobSourcingCronService,
} from './job-sourcing.cron'
import { DEFAULT_JOB_COLLECTION_WINDOW_MS } from '../config/env'

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
  ) => { getNextDateFrom(from: Date): { toUTC(): { toISO(): string } } }
}

const OPTIONS_KEY = 'SCHEDULE_CRON_OPTIONS'
const proto = JobSourcingCronService.prototype
const optionsOf = (fn: unknown) =>
  Reflect.getMetadata(OPTIONS_KEY, fn as object) as { cronTime: string; timeZone: string }

function nextUtc(expr: string, from: string): string {
  return new CronTime(expr, CRON_TIME_ZONE).getNextDateFrom(new Date(from)).toUTC().toISO()
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('schedules (AC 1)', () => {
  it('both decorators carry Europe/Kyiv and their own expression', () => {
    expect(optionsOf(proto.handleDailyCollection)).toMatchObject({
      cronTime: '0 5 * * *',
      timeZone: 'Europe/Kyiv',
    })
    expect(optionsOf(proto.handleHtmlCollection)).toMatchObject({
      cronTime: '30 2 * * *',
      timeZone: 'Europe/Kyiv',
    })
    expect([API_COLLECTION_CRON, HTML_COLLECTION_CRON]).toEqual(['0 5 * * *', '30 2 * * *'])
  })

  it('resolves in Kyiv local time across both 2027 transitions (EET +2, EEST +3)', () => {
    // winter: 02:30 EET = 00:30Z, 05:00 EET = 03:00Z
    expect(nextUtc(HTML_COLLECTION_CRON, '2027-01-10T12:00:00Z')).toBe('2027-01-11T00:30:00.000Z')
    expect(nextUtc(API_COLLECTION_CRON, '2027-01-10T12:00:00Z')).toBe('2027-01-11T03:00:00.000Z')
    // 2027-03-28: Kyiv jumps 03:00 -> 04:00; 02:30 still exists (EET), 05:00 is EEST (+3)
    expect(nextUtc(HTML_COLLECTION_CRON, '2027-03-27T12:00:00Z')).toBe('2027-03-28T00:30:00.000Z')
    expect(nextUtc(API_COLLECTION_CRON, '2027-03-27T12:00:00Z')).toBe('2027-03-28T02:00:00.000Z')
    // summer: 02:30 EEST = 23:30Z the day before
    expect(nextUtc(HTML_COLLECTION_CRON, '2027-07-10T12:00:00Z')).toBe('2027-07-10T23:30:00.000Z')
    // 2027-10-31: Kyiv falls back 04:00 -> 03:00; 02:30 is EEST (+3), 05:00 is EET (+2)
    expect(nextUtc(HTML_COLLECTION_CRON, '2027-10-30T12:00:00Z')).toBe('2027-10-30T23:30:00.000Z')
    expect(nextUtc(API_COLLECTION_CRON, '2027-10-30T12:00:00Z')).toBe('2027-10-31T03:00:00.000Z')
  })
})

describe('type sets', () => {
  it('HTML types go to 02:30, every other reporting type to 05:00, DOU to neither', () => {
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
    countDue: vi.fn(async () => 0),
  }
  const worker = {
    startDue: vi.fn(async (i: { onlyTypes: readonly string[] }) => {
      calls.push(`claim:${i.onlyTypes[0]}`)
      return { claimed: 0, settled: Promise.resolve([]) }
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

describe('the 05:00 handler', () => {
  it('runs open -> recover -> sweep -> DOU -> window (API types) -> close, in that order', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2027-10-31T03:00:00Z') })
    const b = build({})
    await b.svc.handleDailyCollection()
    expect(b.calls[0]).toBe('open:daily-api:2027-10-31')
    expect(b.calls.slice(1)).toEqual([
      'recover',
      'sweep',
      'dou',
      'recover',
      `claim:${API_COLLECTION_TYPES[0]}`,
      'close',
    ])
  })

  it('AC 2: each throwing step leaves the later steps running and nothing is rethrown', async () => {
    const boom = () => Promise.reject(new Error('boom'))
    for (const over of [
      { openCycle: boom },
      { recoverExpired: boom },
      { sweep: boom },
      { collectAll: boom },
    ]) {
      const b = build(over)
      await expect(b.svc.handleDailyCollection()).resolves.toBeUndefined()
      expect(b.calls).toContain('sweep')
      expect(b.calls).toContain('dou')
    }
    // a failing openCycle has no cycle to claim under: no window, but DOU and recovery still ran
    const noCycle = build({ openCycle: boom })
    await noCycle.svc.handleDailyCollection()
    expect(noCycle.worker.startDue).not.toHaveBeenCalled()
    // the later steps of the others still reach the window
    const noRecover = build({ recoverExpired: boom })
    await noRecover.svc.handleDailyCollection()
    expect(noRecover.worker.startDue).toHaveBeenCalledTimes(1)
    expect(noRecover.ledger.closeCycle).toHaveBeenCalledTimes(1)
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
    await b.svc.handleDailyCollection()
    const first = errors.mock.calls.map((c) => String(c[0]))
    expect(first).toContainEqual(
      expect.stringMatching(/^Job sourcing cron step failed \[daily-api: openCycle\]/),
    )
    expect(first).toContainEqual(expect.stringMatching(/\[daily-api: recoverExpired\]/))
    expect(first).toContainEqual(expect.stringMatching(/\[daily-api: sweepOrphanReservations\]/))
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

describe('the window needs a ledger AND a worker AND a cycle', () => {
  it('ledger without a worker: cycle opened and recovery run, but no window and no close', async () => {
    const b = build({})
    const svc = new JobSourcingCronService(b.service as never, b.ledger as never)
    await svc.handleHtmlCollection()
    expect(b.ledger.openCycle).toHaveBeenCalledTimes(1)
    expect(b.ledger.recoverExpired).toHaveBeenCalledTimes(1)
    expect(b.ledger.closeCycle).not.toHaveBeenCalled()
  })

  it('a worker without a ledger does nothing and does not throw', async () => {
    const b = build({})
    const svc = new JobSourcingCronService(b.service as never, undefined, b.worker as never)
    await expect(svc.handleHtmlCollection()).resolves.toBeUndefined()
    expect(b.worker.startDue).not.toHaveBeenCalled()
  })
})
