import type { JobSourceType } from '@crm/shared'
import { describe, expect, it, vi } from 'vitest'
import type { HrAccessService } from '../common/hr-access.service'
import type { DatabaseService } from '../database/database.service'
import type { JobSourceProvider } from './job-source.provider'
import { JobSourcingCronService } from './job-sourcing.cron'
import { JobSourcingService, NotLegacySourceError } from './job-sourcing.service'
import type { ReportingJobSourceProvider } from './providers/reporting-provider'
import { JobSourceRegistry } from './registry/job-source-registry'
import { LegacyDouAdapter, ReportingAdapter } from './registry/registered-adapter'

/**
 * r5 Task 2.5 T7, AC 17 (SR-M-23, "One routing"): the LEGACY path runs only `LEGACY` adapters. A
 * type registered on the reporting contract is refused before the budget, the provider or any
 * request; `collectAll` leaves reporting sources to the run worker. (The ledger half of AC 17 --
 * `claimSource` offered DOU refuses `NOT_ACTIVATABLE` -- is in `job-run-worker.integration.spec`.)
 */
const untouchableDb = new Proxy(
  {},
  {
    get() {
      throw new Error('the database was touched')
    },
  },
) as DatabaseService

function service(db: DatabaseService = untouchableDb) {
  const collectReport = vi.fn()
  const douCollect = vi.fn()
  const registry = new JobSourceRegistry([
    new LegacyDouAdapter({ type: 'DOU_RSS', collect: douCollect } as unknown as JobSourceProvider),
    new ReportingAdapter({
      type: 'REMOTIVE_API',
      parseConfig: (r: unknown) => r,
      collectReport,
    } as unknown as ReportingJobSourceProvider),
  ])
  return {
    svc: new JobSourcingService(db, {} as HrAccessService, registry),
    collectReport,
    douCollect,
  }
}

const source = (type: JobSourceType) => ({
  id: 'id',
  type,
  config: {},
  triggerMode: 'BOTH' as const,
})

describe('one routing (T7, AC 17)', () => {
  it('the legacy path, handed a REPORTING type, throws before any database read or request', async () => {
    const s = service()
    await expect(s.svc.collectSource(source('REMOTIVE_API') as never)).rejects.toBeInstanceOf(
      NotLegacySourceError,
    )
    await expect(s.svc.collectSource(source('REMOTIVE_API') as never)).rejects.toThrow(
      'REMOTIVE_API is a reporting source: it runs only through the run ledger',
    )
    expect(s.collectReport).not.toHaveBeenCalled()
    expect(new NotLegacySourceError('REMOTIVE_API')).toMatchObject({
      name: 'NotLegacySourceError',
      sourceType: 'REMOTIVE_API',
    })
  })

  it('DOU (LEGACY) passes the routing and is collected through its legacy provider', async () => {
    const s = service()
    const error = await s.svc.collectSource(source('DOU_RSS') as never).catch((e: unknown) => e)
    // it fails later (this spec gives it no postings), never at the routing
    expect(error).not.toBeInstanceOf(NotLegacySourceError)
    expect(s.douCollect).toHaveBeenCalledWith({})
  })

  it('an unregistered type is refused as before (no provider), not as a routing error', async () => {
    const s = service()
    const error = await s.svc
      .collectSource(source('ARBEITNOW_API') as never)
      .catch((e: unknown) => e)
    expect(error).not.toBeInstanceOf(NotLegacySourceError)
    expect((error as Error).message).toBe('Нет провайдера для источника ARBEITNOW_API')
  })

  it('collectAll leaves reporting sources to the worker and still collects DOU', async () => {
    const rows = [source('DOU_RSS'), source('REMOTIVE_API'), source('ARBEITNOW_API')].map((r) => ({
      ...r,
      id: `id-${r.type}`,
      enabled: true,
    }))
    const db = {
      db: { select: () => ({ from: () => ({ where: () => Promise.resolve(rows) }) }) },
    } as unknown as DatabaseService
    const s = service(db)
    const ran: string[] = []
    vi.spyOn(s.svc, 'collectSource').mockImplementation(async (src) => {
      ran.push(src.type)
      return { sourceType: src.type } as never
    })
    await s.svc.collectAll()
    // ARBEITNOW_API is not registered at all: it still reaches collectSource, as before (it fails
    // there with "no provider"); only a REGISTERED reporting type is skipped.
    expect(ran).toEqual(['DOU_RSS', 'ARBEITNOW_API'])
  })

  it('the 05:00 handler itself collects DOU through the legacy path, and skips a manual-only source', async () => {
    const rows = [
      { ...source('DOU_RSS'), id: 'id-dou', enabled: true },
      { ...source('REMOTIVE_API'), id: 'id-remotive', enabled: true },
      // a manual-only legacy row: the cron trigger must not run it
      { ...source('DOU_RSS'), id: 'id-dou-manual', enabled: true, triggerMode: 'MANUAL' as const },
    ]
    const db = {
      db: { select: () => ({ from: () => ({ where: () => Promise.resolve(rows) }) }) },
    } as unknown as DatabaseService
    const s = service(db)
    const ran: string[] = []
    vi.spyOn(s.svc, 'collectSource').mockImplementation(async (src) => {
      ran.push(src.id)
      return { sourceType: src.type } as never
    })
    vi.spyOn(s.svc, 'purgeStalePostings').mockResolvedValue(0)
    await new JobSourcingCronService(s.svc).handleDailyCollection()
    expect(ran).toEqual(['id-dou'])
  })
})
