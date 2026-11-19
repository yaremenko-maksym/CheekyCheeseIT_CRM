import { Logger } from '@nestjs/common'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JobSourceTriggerMode, JobSourceType } from '@crm/shared'
import type { HrAccessService } from '../common/hr-access.service'
import type { DatabaseService } from '../database/database.service'
import type { DouRssProvider } from './dou.provider'
import { SourceBlockedError } from './http/source-errors'
import { JobSourcingService } from './job-sourcing.service'
import type { JobRunLedger } from './ownership/job-run-ledger'
import { AUTH_PAUSE_CODE } from './ownership/ledger-policy'

/**
 * task-sources-06-dou AC 3, after fix round 1: a refusal (401 / 403 / 451 / anti-bot challenge) in
 * the LEGACY loop pauses the source through the ledger's OWN `ACCESS_POLICY` cell — the one an
 * ADMIN `resetFailures` clears — and the next run skips it while saying so in the report. No
 * second, unclearable state is written (CR-H-1), and no DB failure can abort the run (CR-H-2).
 */

function makeRow(
  type: JobSourceType = 'DOU_RSS',
  overrides: { lastErrorCode?: string | null; triggerMode?: JobSourceTriggerMode } = {},
) {
  return {
    id: `11111111-1111-4111-8111-11111111111${type === 'DOU_RSS' ? '1' : '2'}`,
    type,
    triggerMode: overrides.triggerMode ?? ('BOTH' as JobSourceTriggerMode),
    config: {},
    enabled: true,
    readiness: 'CANDIDATE',
    lastErrorCode: overrides.lastErrorCode ?? null,
  }
}

/** The `select().from().where()` shape `collectAll` and `readSourcingNotice` both use. */
function dbWith(rows: ReturnType<typeof makeRow>[]): DatabaseService {
  const selectQuery = {
    from: () => ({
      where: () =>
        Object.assign(Promise.resolve(rows), {
          limit: () => Promise.resolve([]),
        }),
    }),
  }
  return { db: { select: () => selectQuery } } as unknown as DatabaseService
}

/**
 * The contract the registry reports PER TYPE, as production does: DOU is the one legacy type, and
 * anything else here is deliberately not LEGACY, so one fake covers both the loop's REPORTING
 * filter and `pauseAfterRefusal`'s LEGACY gate.
 */
const legacyDouOnly = (type: JobSourceType): { contract: string } | undefined =>
  type === 'DOU_RSS' ? { contract: 'LEGACY' } : undefined

function serviceWith(
  db: DatabaseService,
  ledger?: JobRunLedger,
  contractOf: (type: JobSourceType) => { contract: string } | undefined = legacyDouOnly,
): JobSourcingService {
  const service = new JobSourcingService(
    db,
    {} as HrAccessService,
    { type: 'DOU_RSS' } as unknown as DouRssProvider,
    undefined,
    ledger,
  )
  // The production registry is wired by the module; the loop only asks it for the contract.
  Object.defineProperty(service, 'registry', {
    value: { get: contractOf },
    configurable: true,
  })
  return service
}

describe('JobSourcingService legacy loop: a refused source is paused and skipped (AC 3)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('pauses the source through the ledger ACCESS_POLICY cell, and reports the failure', async () => {
    const source = makeRow('DOU_RSS')
    const pauseLegacyAccess = vi.fn().mockResolvedValue(true)
    const service = serviceWith(dbWith([source]), { pauseLegacyAccess } as unknown as JobRunLedger)

    const err = new SourceBlockedError('jobs.dou.ua', 403)
    vi.spyOn(service, 'collectSource').mockRejectedValue(err)

    const run = await service.collectAll('SCHEDULED')

    expect(pauseLegacyAccess).toHaveBeenCalledWith({
      sourceId: source.id,
      message: expect.stringContaining('jobs.dou.ua'),
    })
    // The deliberate-stop arm still owns the report: warn, no error log, flag off the instance.
    expect(run.failures).toHaveLength(1)
    expect(run.failures[0]?.sourceType).toBe('DOU_RSS')
    expect(run.failures[0]?.budgetExhausted).toBe(false)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Job collection skipped for source DOU_RSS'),
    )
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('a rejected pause write does not abort the run: the next source is still collected (CR-H-2)', async () => {
    const dou = makeRow('DOU_RSS')
    const other = makeRow('REMOTEOK_API')
    const pauseLegacyAccess = vi.fn().mockRejectedValue(new Error('connection terminated'))
    const service = serviceWith(dbWith([dou, other]), {
      pauseLegacyAccess,
    } as unknown as JobRunLedger)

    const collect = vi
      .spyOn(service, 'collectSource')
      .mockRejectedValueOnce(new SourceBlockedError('jobs.dou.ua', 403))
      .mockResolvedValueOnce({
        sourceType: 'REMOTEOK_API',
        received: 1,
        created: 1,
        invalid: 0,
        merged: 0,
        filtered: 0,
        suggestionsCreated: 0,
      })

    const run = await service.collectAll('SCHEDULED')

    expect(collect).toHaveBeenCalledTimes(2)
    expect(run.results).toHaveLength(1)
    expect(run.failures).toHaveLength(1)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Access pause write failed for source DOU_RSS'),
    )
  })

  it('a pause write that matched no row is a warn, never a silent no-op (RR-L-1)', async () => {
    const pauseLegacyAccess = vi.fn().mockResolvedValue(false)
    const service = serviceWith(dbWith([makeRow('DOU_RSS')]), {
      pauseLegacyAccess,
    } as unknown as JobRunLedger)
    vi.spyOn(service, 'collectSource').mockRejectedValue(new SourceBlockedError('jobs.dou.ua', 403))

    await service.collectAll('SCHEDULED')

    expect(warnSpy).toHaveBeenCalledWith(
      'Access pause matched no row for source DOU_RSS: it was refused but is not paused',
    )
  })

  it('a pause write that matched its row logs no warn', async () => {
    const pauseLegacyAccess = vi.fn().mockResolvedValue(true)
    const service = serviceWith(dbWith([makeRow('DOU_RSS')]), {
      pauseLegacyAccess,
    } as unknown as JobRunLedger)
    vi.spyOn(service, 'collectSource').mockRejectedValue(new SourceBlockedError('jobs.dou.ua', 403))

    await service.collectAll('SCHEDULED')

    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('matched no row'))
  })

  it('an absent ledger is a warn, never a silent no-op', async () => {
    const service = serviceWith(dbWith([makeRow('DOU_RSS')]), undefined)
    vi.spyOn(service, 'collectSource').mockRejectedValue(new SourceBlockedError('jobs.dou.ua', 403))

    const run = await service.collectAll('SCHEDULED')

    expect(run.failures).toHaveLength(1)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('No run ledger wired'))
  })

  it('a non-LEGACY source keeps its own A1k ban path: no pause write here (spec M)', async () => {
    const pauseLegacyAccess = vi.fn().mockResolvedValue(true)
    const service = serviceWith(dbWith([makeRow('WORKINGNOMADS_API')]), {
      pauseLegacyAccess,
    } as unknown as JobRunLedger)
    vi.spyOn(service, 'collectSource').mockRejectedValue(new SourceBlockedError('h.test', 451))

    const run = await service.collectAll('SCHEDULED')

    expect(pauseLegacyAccess).not.toHaveBeenCalled()
    expect(run.failures).toHaveLength(1)
  })

  it('an ordinary deliberate stop writes no pause', async () => {
    const pauseLegacyAccess = vi.fn().mockResolvedValue(true)
    const service = serviceWith(dbWith([makeRow('DOU_RSS')]), {
      pauseLegacyAccess,
    } as unknown as JobRunLedger)
    vi.spyOn(service, 'collectSource').mockRejectedValue(new Error('dou is down'))

    const run = await service.collectAll('SCHEDULED')

    expect(pauseLegacyAccess).not.toHaveBeenCalled()
    expect(run.failures).toHaveLength(1)
    expect(errorSpy).toHaveBeenCalled()
  })

  it('the second run skips the paused source, and says so instead of going quiet', async () => {
    const paused = makeRow('DOU_RSS', { lastErrorCode: AUTH_PAUSE_CODE })
    const service = serviceWith(dbWith([paused]))
    const collect = vi.spyOn(service, 'collectSource')

    const run = await service.collectAll('SCHEDULED')

    expect(collect).not.toHaveBeenCalled()
    expect(run.results).toHaveLength(0)
    expect(run.failures).toHaveLength(1)
    expect(run.failures[0]?.message).toContain(AUTH_PAUSE_CODE)
    // A pause is not a spent budget: the two are different states on the admin card, and
    // `budgetExhausted: true` here would tell the owner to wait for a window that never opens.
    expect(run.failures[0]?.budgetExhausted).toBe(false)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Job collection skipped for paused source DOU_RSS'),
    )
  })

  it('a cleared cell (what an ADMIN resetFailures leaves) makes the source collectable again', async () => {
    const service = serviceWith(dbWith([makeRow('DOU_RSS', { lastErrorCode: null })]))
    const collect = vi.spyOn(service, 'collectSource').mockResolvedValue({
      sourceType: 'DOU_RSS',
      received: 2,
      created: 2,
      invalid: 0,
      merged: 0,
      filtered: 0,
      suggestionsCreated: 0,
    })

    const run = await service.collectAll('SCHEDULED')

    expect(collect).toHaveBeenCalledTimes(1)
    expect(run.results).toHaveLength(1)
    expect(run.failures).toHaveLength(0)
  })

  it('another error code is not the access pause: the source is still collected', async () => {
    const service = serviceWith(dbWith([makeRow('DOU_RSS', { lastErrorCode: 'UPSTREAM' })]))
    const collect = vi.spyOn(service, 'collectSource').mockResolvedValue({
      sourceType: 'DOU_RSS',
      received: 1,
      created: 1,
      invalid: 0,
      merged: 0,
      filtered: 0,
      suggestionsCreated: 0,
    })

    await service.collectAll('SCHEDULED')

    expect(collect).toHaveBeenCalledTimes(1)
  })
})
