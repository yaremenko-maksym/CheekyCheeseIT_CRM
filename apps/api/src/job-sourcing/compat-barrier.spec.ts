import { Logger } from '@nestjs/common'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { budgetWindowStart } from '@crm/shared'
import { jobSources } from '../database/schema'
import type { DatabaseService } from '../database/database.service'
import type { HrAccessService } from '../common/hr-access.service'
import type { DouRssProvider } from './dou.provider'
import { JobSourceBudgetExhaustedError } from './source-budget.error'
import { JobSourcingService, type BudgetedSource } from './job-sourcing.service'
import { BRIDGE_FLAG_VALUES, bridgeConfig } from './bridge-flag.test-helper'

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
 * QUEUE FLAG (S6a): every case runs for `JOB_QUEUE_BRIDGE_ENABLED` off AND on (`describe.each`).
 * Until S6c/S6d the flag-on path is the same code, so the on-variant is green by construction;
 * from S6c every slice must keep both green. The off-variant additionally asserts the legacy path
 * makes no run-ledger call and no bridge-table query (see the last describe).
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
function makeHarness(collectImpl: () => Promise<unknown[]>, listRows: Row[] = [], flagOn = false) {
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
  const service = new JobSourcingService(
    db,
    {} as unknown as HrAccessService,
    provider,
    bridgeConfig(flagOn),
  )
  return { service, events, written, collect, update, select }
}

describe.each(BRIDGE_FLAG_VALUES)(
  'Compat barrier — budget arithmetic (bridge flag %s)',
  (flagOn) => {
    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(NOW)
    })
    afterEach(() => {
      vi.useRealTimers()
      vi.restoreAllMocks()
    })

    it('C-06: one collectSource writes exactly ONE unit (used 3 -> 4), and does so BEFORE the provider is asked', async () => {
      const { service, events, written } = makeHarness(() => Promise.resolve([]), [], flagOn)

      await expect(service.collectSource(dayRow())).rejects.toThrow(/0 usable postings/)

      // Order is the pin: charge first, network second. A reordering keeps every count below green
      // and fails only here.
      expect(events).toEqual(['db.update', 'provider.collect'])
      expect(written).toHaveLength(1)
      expect(written[0]).toMatchObject({ budgetUsed: 4, updatedAt: NOW })
      expect(written[0]?.['budgetWindowStartedAt']).toEqual(budgetWindowStart(NOW, 'DAY'))
    })

    it('C-05 x C-06: a zero-postings run keeps its spent unit and NEVER writes lastCollectedAt', async () => {
      const { service, written } = makeHarness(() => Promise.resolve([]), [], flagOn)

      await expect(service.collectSource(dayRow())).rejects.toThrow(
        'Source DOU_RSS returned 0 usable postings — feed format changed, source is down, or every entry was rejected. lastCollectedAt left unchanged.',
      )

      // The only write is the budget charge. A second write would be the lastCollectedAt stamp.
      expect(written).toHaveLength(1)
      expect(written[0]).not.toHaveProperty('lastCollectedAt')
      expect(written[0]).toHaveProperty('budgetUsed', 4)
    })

    it('a provider that THROWS still costs the unit already charged (no refund path)', async () => {
      const { service, events, written } = makeHarness(
        () => Promise.reject(new Error('dou is down')),
        [],
        flagOn,
      )

      await expect(service.collectSource(dayRow())).rejects.toThrow('dou is down')

      expect(events).toEqual(['db.update', 'provider.collect'])
      expect(written).toHaveLength(1)
      expect(written[0]).toMatchObject({ budgetUsed: 4 })
    })

    it('an exhausted source: typed stop, the provider is never asked, nothing is written', async () => {
      const { service, events, written, collect } = makeHarness(
        () => Promise.resolve([]),
        [],
        flagOn,
      )

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
      const { service, collect } = makeHarness(() => Promise.resolve([]), [], flagOn)

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
      const { service, written } = makeHarness(() => Promise.resolve([]), [], flagOn)
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
      const { service, events, written } = makeHarness(() => Promise.resolve([]), [], flagOn)

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
  },
)

describe.each(BRIDGE_FLAG_VALUES)(
  'Compat barrier — collectAll classification (bridge flag %s)',
  (flagOn) => {
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
      const { service } = makeHarness(() => Promise.resolve([]), [dayRow()], flagOn)

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
        flagOn,
      )

      const run = await service.collectAll('SCHEDULED')

      expect(run.failures[0]).toMatchObject({ sourceType: 'DOU_RSS', budgetExhausted: true })
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(errorSpy).not.toHaveBeenCalled()
      expect(collect).not.toHaveBeenCalled()
    })
  },
)

describe.each(BRIDGE_FLAG_VALUES)('Compat barrier — new pins (bridge flag %s)', (flagOn) => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('twenty sequential clicks spend twenty units: used 0 -> 20, one write each, then the 21st is refused', async () => {
    const { service, written, collect } = makeHarness(() => Promise.resolve([]), [], flagOn)
    let used = 0

    for (let click = 1; click <= 20; click++) {
      await expect(
        service.collectSource(dayRow({ budgetLimit: 20, budgetUsed: used })),
      ).rejects.toThrow(/0 usable postings/)
      used = written[written.length - 1]?.['budgetUsed'] as number
      expect(used).toBe(click)
    }

    expect(written).toHaveLength(20)
    expect(collect).toHaveBeenCalledTimes(20)
    await expect(
      service.collectSource(dayRow({ budgetLimit: 20, budgetUsed: used })),
    ).rejects.toBeInstanceOf(JobSourceBudgetExhaustedError)
    expect(written).toHaveLength(20)
    expect(collect).toHaveBeenCalledTimes(20)
  })

  if (flagOn) {
    // Flag ON diverges here from S6c/S6d (ADR 2026-10-31-dou-bridge-run-ownership, section 1 table):
    // the second concurrent collection of the same source gets JobSourceRunBusyError and spends
    // ZERO units. Asserted per flag value, not by parity.
    it.todo(
      'flag ON: two concurrent collections of one source -> the second throws JobSourceRunBusyError and spends zero units (S6c/S6d)',
    )
  } else {
    it('flag OFF: two concurrent collections of one source BOTH proceed -- two provider calls, two units', async () => {
      let release: () => void = () => undefined
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const { service, written, collect } = makeHarness(
        async () => {
          await gate
          return []
        },
        [],
        flagOn,
      )

      const settled = Promise.allSettled([
        service.collectSource(dayRow({ budgetUsed: 0 })),
        service.collectSource(dayRow({ budgetUsed: 0 })),
      ])
      // Let both reach the provider before either may finish.
      await vi.advanceTimersByTimeAsync(0)
      expect(collect).toHaveBeenCalledTimes(2)
      release()
      const results = await settled

      expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected'])
      expect(written).toHaveLength(2)
      expect(written.map((w) => w['budgetUsed'])).toEqual([1, 1])
    })
  }
})

describe('Compat barrier — the flag is read once and the OFF branch touches only job_sources', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  /** A db whose every property read is recorded, and whose update tables are recorded. */
  function recordingService(config: ReturnType<typeof bridgeConfig> | undefined) {
    const touched: string[] = []
    const tables: unknown[] = []
    const base = {
      update: (table: unknown) => {
        tables.push(table)
        return {
          set: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: SOURCE_ID }]) }) }),
        }
      },
    }
    const dbDouble = new Proxy(base, {
      get(target, key) {
        touched.push(String(key))
        return (target as Record<string, unknown>)[String(key)]
      },
    })
    const provider = {
      type: 'DOU_RSS',
      collect: vi.fn().mockResolvedValue([]),
    } as unknown as DouRssProvider
    const service = new JobSourcingService(
      { db: dbDouble } as unknown as DatabaseService,
      {} as unknown as HrAccessService,
      provider,
      config,
    )
    return { service, touched, tables }
  }

  it('flag OFF: no ledger call and no bridge-table query -- only update(job_sources), no select/insert/delete/execute/transaction', async () => {
    const { service, touched, tables } = recordingService(bridgeConfig(false))

    await expect(service.collectSource(dayRow())).rejects.toThrow(/0 usable postings/)

    expect(new Set(touched)).toEqual(new Set(['update']))
    expect(tables).toEqual([jobSources])
  })

  it('no ConfigService (hand-built callers) means OFF, same observable behaviour', async () => {
    const { service, touched, tables } = recordingService(undefined)

    await expect(service.collectSource(dayRow())).rejects.toThrow(/0 usable postings/)

    expect(new Set(touched)).toEqual(new Set(['update']))
    expect(tables).toEqual([jobSources])
  })

  it('the flag is read ONCE at construction: later config changes do not move a built service', async () => {
    let value = false
    const get = vi.fn((key: string) => (key === 'JOB_QUEUE_BRIDGE_ENABLED' ? value : undefined))
    const { service } = recordingService({ get } as unknown as ReturnType<typeof bridgeConfig>)
    expect(get).toHaveBeenCalledTimes(1)

    value = true
    await expect(service.collectSource(dayRow())).rejects.toThrow(/0 usable postings/)

    expect(get).toHaveBeenCalledTimes(1)
  })

  it('flag ON dispatches to the bridge entry point; OFF does not', async () => {
    const on = recordingService(bridgeConfig(true)).service
    const off = recordingService(bridgeConfig(false)).service
    const viaBridgeOn = vi.spyOn(on as never, 'collectViaBridge')
    const viaBridgeOff = vi.spyOn(off as never, 'collectViaBridge')

    await expect(on.collectSource(dayRow())).rejects.toThrow(/0 usable postings/)
    await expect(off.collectSource(dayRow())).rejects.toThrow(/0 usable postings/)

    expect(viaBridgeOn).toHaveBeenCalledTimes(1)
    expect(viaBridgeOff).not.toHaveBeenCalled()
  })
})
