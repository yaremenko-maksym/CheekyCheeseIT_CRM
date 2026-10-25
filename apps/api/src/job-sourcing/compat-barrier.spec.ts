import { Logger } from '@nestjs/common'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { budgetWindowStart } from '@crm/shared'
import type { DatabaseService } from '../database/database.service'
import type { HrAccessService } from '../common/hr-access.service'
import type { DouRssProvider } from './dou.provider'
import { JobSourceBudgetExhaustedError } from './source-budget.error'
import { JobSourcingService, type BudgetedSource } from './job-sourcing.service'

/**
 * Compatibility barrier (r5 Task 4.6a) — the ONE-UNIT BUDGET ARITHMETIC and the C-05 zero-postings
 * semantics of the legacy DOU path, pinned at the unit level with a recording database double.
 *
 * What is already pinned elsewhere (not repeated here): the 3-attempt cap and the typed
 * contention/exhaustion stops (`job-sourcing-budget-contention.spec.ts`), the trigger-mode truth
 * table (`scheduling/due-policy.spec.ts`), `collectAll` source selection
 * (`job-sourcing-collect-all-types.spec.ts`). What was NOT pinned and is here: the ORDER of the
 * charge and the provider, the exact unit count written, that the unit stays spent when the
 * provider yields nothing or throws, that a window rollover restarts the count at one, and how
 * `collectAll` classifies a zero-postings source (a failure, `budgetExhausted: false`, error log).
 *
 * QUEUE FLAG: no queue flag exists in product code at the time of writing (checked: no env key and
 * no service branch named for one). This suite therefore proves the legacy path only; the flag-on
 * variant is NOT exercised and is recorded as an `it.todo` in compat-barrier.integration.spec.ts. Adding it later needs the flag to
 * be wired first (Task 4.6d); it is not a parameter flip.
 */

const SOURCE_ID = 'c0mpa7ba-0000-4000-8000-000000000001'
/** Controlled clock: every test runs at this instant. */
const NOW = new Date('2026-03-15T10:00:00.000Z')

type Row = BudgetedSource & { triggerMode: 'SCHEDULED'; enabled: true }

function dayRow(over: Partial<Row> = {}): Row {
  return {
    id: SOURCE_ID,
    type: 'DOU_RSS',
    config: {},
    budgetLimit: 10,
    budgetWindow: 'DAY',
    budgetUsed: 3,
    budgetWindowStartedAt: budgetWindowStart(NOW, 'DAY'),
    triggerMode: 'SCHEDULED',
    enabled: true,
    ...over,
  }
}

/** A database double that WINS every compare-and-set and records what was written, in order. */
function makeHarness(collectImpl: () => Promise<unknown[]>, listRows: Row[] = []) {
  const events: string[] = []
  const written: Array<Record<string, unknown>> = []
  const update = vi.fn().mockImplementation(() => ({
    set: (payload: Record<string, unknown>) => {
      events.push('db.update')
      written.push(payload)
      return {
        where: () => ({ returning: () => Promise.resolve([{ id: SOURCE_ID }]) }),
      }
    },
  }))
  // `collectAll`'s enabled-rows read awaits `.where()` directly.
  const select = vi.fn().mockImplementation(() => ({
    from: () => ({ where: () => Promise.resolve(listRows) }),
  }))
  const collect = vi.fn().mockImplementation(() => {
    events.push('provider.collect')
    return collectImpl()
  })
  const provider = { type: 'DOU_RSS', collect } as unknown as DouRssProvider
  const db = { db: { update, select } } as unknown as DatabaseService
  const service = new JobSourcingService(db, {} as unknown as HrAccessService, provider)
  return { service, events, written, collect, update }
}

describe('Compat barrier — legacy DOU path, queue flag does not exist yet: budget arithmetic', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('C-06: one collectSource writes exactly ONE unit (used 3 -> 4), and does so BEFORE the provider is asked', async () => {
    const { service, events, written } = makeHarness(() => Promise.resolve([]))

    await expect(service.collectSource(dayRow())).rejects.toThrow(/0 usable postings/)

    // Order is the pin: charge first, network second. A reordering keeps every count below green
    // and fails only here.
    expect(events).toEqual(['db.update', 'provider.collect'])
    expect(written).toHaveLength(1)
    expect(written[0]).toMatchObject({ budgetUsed: 4, updatedAt: NOW })
    expect(written[0]?.['budgetWindowStartedAt']).toEqual(budgetWindowStart(NOW, 'DAY'))
  })

  it('C-05 x C-06: a zero-postings run keeps its spent unit and NEVER writes lastCollectedAt', async () => {
    const { service, written } = makeHarness(() => Promise.resolve([]))

    await expect(service.collectSource(dayRow())).rejects.toThrow(
      'Source DOU_RSS returned 0 usable postings — feed format changed, source is down, or every entry was rejected. lastCollectedAt left unchanged.',
    )

    // The only write is the budget charge. A second write would be the lastCollectedAt stamp.
    expect(written).toHaveLength(1)
    expect(written[0]).not.toHaveProperty('lastCollectedAt')
    expect(written[0]).toHaveProperty('budgetUsed', 4)
  })

  it('a provider that THROWS still costs the unit already charged (no refund path)', async () => {
    const { service, events, written } = makeHarness(() => Promise.reject(new Error('dou is down')))

    await expect(service.collectSource(dayRow())).rejects.toThrow('dou is down')

    expect(events).toEqual(['db.update', 'provider.collect'])
    expect(written).toHaveLength(1)
    expect(written[0]).toMatchObject({ budgetUsed: 4 })
  })

  it('an exhausted source: typed stop, the provider is never asked, nothing is written', async () => {
    const { service, events, written, collect } = makeHarness(() => Promise.resolve([]))

    const err = await service
      .collectSource(dayRow({ budgetUsed: 10 }))
      .then(() => null)
      .catch((e: unknown) => e)

    expect(err).toBeInstanceOf(JobSourceBudgetExhaustedError)
    expect((err as JobSourceBudgetExhaustedError).budgetExhausted).toBe(true)
    expect(events).toEqual([])
    expect(written).toEqual([])
    expect(collect).not.toHaveBeenCalled()
  })

  it('the last unit is spendable: used 9 of 10 -> 10, then the NEXT call is refused', async () => {
    const { service, collect } = makeHarness(() => Promise.resolve([]))

    await expect(service.collectSource(dayRow({ budgetUsed: 9 }))).rejects.toThrow(
      /0 usable postings/,
    )
    expect(collect).toHaveBeenCalledTimes(1)

    await expect(service.collectSource(dayRow({ budgetUsed: 10 }))).rejects.toBeInstanceOf(
      JobSourceBudgetExhaustedError,
    )
    expect(collect).toHaveBeenCalledTimes(1)
  })

  it('a window that rolled over restarts the count at ONE, not at used+1', async () => {
    const { service, written } = makeHarness(() => Promise.resolve([]))
    // Yesterday's window, fully spent: today the source has a fresh allowance.
    const staleRow = dayRow({
      budgetUsed: 10,
      budgetWindowStartedAt: budgetWindowStart(new Date('2026-03-14T10:00:00.000Z'), 'DAY'),
    })

    await expect(service.collectSource(staleRow)).rejects.toThrow(/0 usable postings/)

    expect(written).toHaveLength(1)
    expect(written[0]).toMatchObject({ budgetUsed: 1 })
    expect(written[0]?.['budgetWindowStartedAt']).toEqual(budgetWindowStart(NOW, 'DAY'))
  })

  it('an unlimited source (DOU as seeded) is never charged: the provider is asked, no budget write', async () => {
    const { service, events, written } = makeHarness(() => Promise.resolve([]))

    await expect(
      service.collectSource(
        dayRow({
          budgetLimit: null,
          budgetWindow: null,
          budgetUsed: 0,
          budgetWindowStartedAt: null,
        }),
      ),
    ).rejects.toThrow(/0 usable postings/)

    expect(events).toEqual(['provider.collect'])
    expect(written).toEqual([])
  })
})

describe('Compat barrier — legacy DOU path, queue flag does not exist yet: collectAll classification', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('C-05: zero postings is a FAILURE with budgetExhausted=false, logged as an error (not a deliberate stop)', async () => {
    const { service } = makeHarness(() => Promise.resolve([]), [dayRow()])

    const run = await service.collectAll('SCHEDULED')

    expect(run.results).toEqual([])
    expect(run.failures).toHaveLength(1)
    expect(run.failures[0]).toMatchObject({ sourceType: 'DOU_RSS', budgetExhausted: false })
    expect(run.failures[0]?.message).toMatch(/0 usable postings/)
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('CONTROL: genuine exhaustion on the same path is the opposite classification (true, warn, no error log)', async () => {
    const { service, collect } = makeHarness(
      () => Promise.resolve([]),
      [dayRow({ budgetUsed: 10 })],
    )

    const run = await service.collectAll('SCHEDULED')

    expect(run.failures[0]).toMatchObject({ sourceType: 'DOU_RSS', budgetExhausted: true })
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy).not.toHaveBeenCalled()
    expect(collect).not.toHaveBeenCalled()
  })
})
