import { describe, expect, it, vi } from 'vitest'
import type { JobCollectionResultDto, JobSourceTriggerMode, JobSourceType } from '@crm/shared'
import type { HrAccessService } from '../common/hr-access.service'
import type { DatabaseService } from '../database/database.service'
import type { DouRssProvider } from './dou.provider'
import { JobSourcingService } from './job-sourcing.service'

/**
 * Task 2.5 T4 AC4: `collectAll` with `onlyTypes` runs no source outside the set, and with
 * `excludeTypes` runs none inside it. The service is driven through its real `collectAll`; only the
 * enabled-rows read and `collectSource` (which would call a provider and charge a budget) are
 * stubbed, so what is observed is WHICH sources the run reaches.
 */
function row(type: JobSourceType, triggerMode: JobSourceTriggerMode = 'BOTH') {
  return { id: `id-${type}`, type, triggerMode, config: {}, enabled: true }
}

function makeService(rows: ReturnType<typeof row>[]) {
  const db = {
    db: { select: () => ({ from: () => ({ where: () => Promise.resolve(rows) }) }) },
  } as unknown as DatabaseService
  const service = new JobSourcingService(
    db,
    {} as HrAccessService,
    {
      type: 'DOU_RSS',
    } as unknown as DouRssProvider,
  )
  const ran: string[] = []
  vi.spyOn(service, 'collectSource').mockImplementation((source) => {
    ran.push(source.type)
    // Only `sourceType` is read by these tests; the rest of the result DTO is irrelevant here.
    return Promise.resolve({ sourceType: source.type } as JobCollectionResultDto)
  })
  return { service, ran }
}

// WORKINGNOMADS_API and JUSTJOIN_HTML have no registered adapter, so the legacy loop still reaches
// them; REMOTEOK_API and REED_API are registered REPORTING types and never run here (SR-M-23).
const ROWS = [
  row('DOU_RSS'),
  row('REED_API'),
  row('JUSTJOIN_HTML', 'MANUAL'),
  row('WORKINGNOMADS_API', 'SCHEDULED'),
  row('REMOTEOK_API'),
]

describe('collectAll type selection (T4)', () => {
  it('no filter keeps today behaviour: every enabled source that accepts the trigger runs', async () => {
    const { service, ran } = makeService(ROWS)
    await service.collectAll()
    expect(ran).toEqual(['DOU_RSS', 'WORKINGNOMADS_API'])
    await service.collectAll('MANUAL')
    expect(ran.slice(2)).toEqual(['DOU_RSS', 'JUSTJOIN_HTML'])
  })

  it('onlyTypes runs no source outside the set', async () => {
    const { service, ran } = makeService(ROWS)
    const out = await service.collectAll('SCHEDULED', { onlyTypes: ['WORKINGNOMADS_API'] })
    expect(ran).toEqual(['WORKINGNOMADS_API'])
    expect(out.results.map((r) => r.sourceType)).toEqual(['WORKINGNOMADS_API'])
  })

  it('a registered REPORTING type is the run worker’s: the legacy loop never reaches it', async () => {
    const { service, ran } = makeService(ROWS)
    await service.collectAll('SCHEDULED', { onlyTypes: ['REMOTEOK_API', 'REED_API'] })
    expect(ran).toEqual([])
  })

  it('excludeTypes runs no source inside the set', async () => {
    const { service, ran } = makeService(ROWS)
    await service.collectAll('SCHEDULED', { excludeTypes: ['DOU_RSS'] })
    expect(ran).toEqual(['WORKINGNOMADS_API'])
  })

  it('an empty onlyTypes runs nothing; the trigger policy still applies inside the set', async () => {
    const { service, ran } = makeService(ROWS)
    await service.collectAll('SCHEDULED', { onlyTypes: [] })
    expect(ran).toEqual([])
    await service.collectAll('SCHEDULED', { onlyTypes: ['JUSTJOIN_HTML', 'DOU_RSS'] })
    expect(ran).toEqual(['DOU_RSS'])
  })
})
